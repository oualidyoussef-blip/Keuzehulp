/**
 * KEUZEHULP PROXY — Lightspeed eCom → keuzehulp.html
 * ----------------------------------------------------------------------------
 * Doel: nooit de Lightspeed API-credentials in de browser blootstellen.
 * Deze server haalt live producten + filters + voorraad op, transformeert
 * ze naar de vorm die keuzehulp.html's MOCK_PRODUCTS al gebruikt, en cachet
 * het resultaat.
 *
 * TE VERIFIËREN VOORDAT JE DIT DRAAIT (zie developers.lightspeedhq.com):
 *   - Exact auth-schema van jullie account (Basic Auth met key/secret,
 *     of OAuth2). Pas authHeader() hieronder aan indien nodig.
 *   - Exacte endpoint-paden en veldnamen (products/variants/stockLevels/filters
 *     kunnen anders heten of genest zijn in de actuele API-versie).
 * ----------------------------------------------------------------------------
 */

const express = require('express');
const path = require('path');
const app = express();

// ---------------------------------------------------------------------------
// DEBUG-ENDPOINTS BEVEILIGEN — deze routes geven je volledige productcatalogus,
// prijzen en interne tag-structuur bloot, en negeren bewust de cache (dus
// zwaarder voor de Lightspeed API bij elk bezoek). Daarom nu achter een
// wachtwoord via HTTP Basic Auth.
//
// Zet DEBUG_PASSWORD als environment variable op je hosting (Render:
// Environment → Add Environment Variable). Gebruikersnaam maakt niet uit,
// vul iets in zoals "admin".
// ---------------------------------------------------------------------------
const DEBUG_PASSWORD = process.env.DEBUG_PASSWORD;

function requireDebugAuth(req, res, next) {
  if (!DEBUG_PASSWORD) {
    // Geen wachtwoord ingesteld op de server -> debug-routes blijven dicht,
    // veiliger dan per ongeluk open laten staan.
    return res.status(503).json({ error: 'DEBUG_PASSWORD is niet ingesteld op de server. Debug-endpoints zijn daardoor uitgeschakeld.' });
  }
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Keuzehulp debug"');
    return res.status(401).send('Authenticatie vereist.');
  }
  const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
  const [, password] = decoded.split(':'); // gebruikersnaam wordt genegeerd, alleen wachtwoord checken
  if (password !== DEBUG_PASSWORD) {
    res.set('WWW-Authenticate', 'Basic realm="Keuzehulp debug"');
    return res.status(401).send('Onjuist wachtwoord.');
  }
  next();
}

app.use('/api/debug', requireDebugAuth);

// ---------------------------------------------------------------------------
// STATIC HOSTING — serveert keuzehulp.html vanaf dezelfde server als de API.
// Zet keuzehulp.html in dezelfde map als dit bestand (server.js).
// Resultaat: https://jouw-domein.nl/keuzehulp.html
// Voordeel: same-origin met /api/keuzehulp/products, dus geen CORS nodig.
// ---------------------------------------------------------------------------
app.use(express.static(path.join(__dirname)));

// ---------------------------------------------------------------------------
// HEALTH CHECK — bedoeld voor een externe keep-alive-ping (bijv. UptimeRobot
// of cron-job.org), zodat Render's gratis tier niet inslaapt na inactiviteit.
// Doet BEWUST geen Lightspeed-calls, dus kost geen rate-limit-budget.
// Zet hier de URL van dit endpoint in bij je keep-alive-dienst, elke 10-14 min.
// ---------------------------------------------------------------------------
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// ---------------------------------------------------------------------------
// CONFIG — zet deze in environment variables, nooit hardcoded in git
// BEVESTIGD via developers.lightspeedhq.com: EU1-cluster voor .webshopapp.com
// shops is altijd https://api.webshopapp.com/{taal}/ — dus NIET het eigen
// shop-subdomein. Jullie shop wordt herkend via de key/secret zelf.
// ---------------------------------------------------------------------------
const LIGHTSPEED_API_BASE = process.env.LIGHTSPEED_API_BASE || 'https://api.webshopapp.com/nl';
const API_KEY    = process.env.LIGHTSPEED_API_KEY;
const API_SECRET = process.env.LIGHTSPEED_API_SECRET;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 uur — verhoogd vanaf 30 min als extra buffer tegen rate limits

if (!API_KEY || !API_SECRET) {
  console.error('Ontbrekende LIGHTSPEED_API_KEY / LIGHTSPEED_API_SECRET in environment.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// AUTH — BEVESTIGD: HTTP Basic Auth met api_key als username, api_secret als
// wachtwoord. Geen OAuth2 nodig voor deze klassieke eCom (SEOshop) API.
// ---------------------------------------------------------------------------
function authHeader() {
  const token = Buffer.from(`${API_KEY}:${API_SECRET}`).toString('base64');
  return `Basic ${token}`;
}

async function lsFetch(path) {
  const res = await fetch(`${LIGHTSPEED_API_BASE}${path}`, {
    headers: {
      'Authorization': authHeader(),
      'Accept': 'application/json',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Lightspeed API ${path} gaf ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// CACHE — simpele in-memory cache, voorkomt rate-limit issues bij elke bezoeker
// ---------------------------------------------------------------------------
let cache = { data: null, fetchedAt: 0 };
let backgroundRefreshInProgress = false;

async function refreshCacheInBackground() {
  if (backgroundRefreshInProgress) return; // voorkomt dat meerdere verzoeken tegelijk een refresh starten
  backgroundRefreshInProgress = true;
  try {
    const products = await fetchAndTransformProducts();
    cache = { data: products, fetchedAt: Date.now() };
  } catch (err) {
    console.error('Achtergrond-refresh van de cache mislukt:', err.message);
    // cache.data blijft staan (oude data) zodat bezoekers niets merken van deze mislukking
  } finally {
    backgroundRefreshInProgress = false;
  }
}

async function getLiveProducts() {
  const now = Date.now();

  if (!cache.data) {
    // Allereerste keer sinds de server is opgestart: nog niets om te tonen,
    // dus nu moeten we wél wachten op de eerste fetch.
    const products = await fetchAndTransformProducts();
    cache = { data: products, fetchedAt: now };
    return products;
  }

  if ((now - cache.fetchedAt) >= CACHE_TTL_MS) {
    // SNELHEIDSFIX (stale-while-revalidate): cache is verlopen, maar we hebben
    // nog wel (net iets oudere) data. In plaats van de bezoeker te laten
    // wachten op een verse fetch, tonen we meteen de bestaande data en
    // verversen we op de achtergrond voor de VOLGENDE bezoeker. Zo wacht
    // vrijwel niemand meer op een cache-miss.
    refreshCacheInBackground(); // bewust niet awaiten
  }

  return cache.data;
}

// ---------------------------------------------------------------------------
// TRANSFORMATIE — haalt producten + tags + voorraad op en zet ze om naar
// exact de vorm die keuzehulp.html verwacht:
//   { id, category, name, specs, price, stock, active, url }
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// TAGS ALS DRAGER VAN SPECS — WAAROM NIET FILTERS
// ----------------------------------------------------------------------------
// In de officiële docs (developers.lightspeedhq.com) kon ik geen bevestigd
// endpoint vinden dat teruggeeft welke Filter-waarden aan een specifiek
// product hangen (Filter en FilterValue geven alleen de filter-definities
// en mogelijke waarden, geen per-product koppeling).
//
// TagsProduct (/tags/products.json?product={id}) is dat WEL, gedocumenteerd
// en bevestigd. Daarom gebruikt deze proxy Tags als drager van de specs,
// via een naamgevingsconventie. De Filters die je al had ingericht blijven
// gewoon bruikbaar voor het filteren op de website zelf (storefront) — ze
// worden alleen niet gebruikt door déze proxy.
//
// TAG-CONVENTIE (voeg deze tags toe aan de relevante producten in Lightspeed):
//   category:zonnepanelen | category:batterij | category:omvormer | category:laadpaal
//   spec:fase:1-fase | spec:fase:3-fase
//   spec:vermogenwp:440              (zonnepanelen, Wp per paneel)
//   spec:vermogenkw:5                (omvormer/laadpaal, kW)
//   spec:capaciteitkwh:10.2          (batterij, kWh)
//   spec:hybride:true  | spec:hybride:false
//   spec:slim:true      | spec:slim:false
//
// LET OP: dit ís de laatste stap die je zelf moet zetten voordat de matching
// werkt — zie mijn bericht in de chat voor het volledige stappenplan.
// ---------------------------------------------------------------------------

let tagCache = { byId: null, fetchedAt: 0 };
const TAG_CACHE_TTL_MS = 60 * 60 * 1000; // 1 uur — zelfde als CACHE_TTL_MS, blijft synchroon

async function getTagTitleMap() {
  const now = Date.now();
  if (tagCache.byId && (now - tagCache.fetchedAt) < TAG_CACHE_TTL_MS) {
    return tagCache.byId;
  }
  const byId = {};
  let page = 1;
  while (true) {
    const resp = await lsFetch(`/tags.json?limit=250&page=${page}`);
    const tags = resp.tags || [];
    for (const t of tags) byId[t.id] = t.title;
    if (tags.length < 250) break;
    page++;
  }
  tagCache = { byId, fetchedAt: now };
  return byId;
}

// Normaliseert lowercase tag-sleutels (makkelijker te typen bij het taggen)
// naar de exacte camelCase veldnamen die keuzehulp.html's matching-logica
// verwacht (zie getMatches()/formatSpecs() in keuzehulp.html).
const SPEC_KEY_ALIASES = {
  fase: 'fase',
  vermogenwp: 'vermogenWp',
  vermogenkw: 'vermogenKw',
  capaciteitkwh: 'capaciteitKwh',
  hybride: 'hybride',
  slim: 'slim',
};

// ---------------------------------------------------------------------------
// ALLE TAG-PRODUCTKOPPELINGEN IN ÉÉN KEER OPHALEN
// ----------------------------------------------------------------------------
// LET OP / BUGFIX: eerder vertrouwde dit op GET /tags/products.json?product={id}
// om alleen de koppelingen van dat ene product terug te krijgen. Die filter
// stond wel in een voorbeeld-link in de docs, maar was niet bevestigd als
// ondersteunde filter op dit endpoint. Als hij in de praktijk niet werkt,
// kreeg elk product de ongefilterde (gepagineerde) lijst van de hele shop
// terug, en werd de koppeling nooit gelegd -> category bleef null -> product
// werd overgeslagen. Dit is vermoedelijk de oorzaak als je "geen producten"
// zag ondanks correct getagde producten.
//
// Oplossing: haal ALLE tagsProducts-koppelingen op (gepagineerd, net als
// getTagTitleMap hierboven) en bouw zelf een productId -> [tagIds] index.
// Werkt gegarandeerd correct, ongeacht of de product-filter ondersteund wordt.
// ---------------------------------------------------------------------------
async function getAllProductTagIds() {
  const productIdToTagIds = {};
  let page = 1;
  while (true) {
    const resp = await lsFetch(`/tags/products.json?limit=250&page=${page}`);
    const assocs = resp.tagsProducts || [];
    for (const a of assocs) {
      const productId = a.product?.resource?.id;
      const tagId = a.tag?.resource?.id;
      if (!productId || !tagId) continue;
      if (!productIdToTagIds[productId]) productIdToTagIds[productId] = [];
      productIdToTagIds[productId].push(tagId);
    }
    if (assocs.length < 250) break;
    page++;
  }
  return productIdToTagIds;
}

function parseCategoryAndSpecs(tagIds, tagTitleMap) {
  let category = null;
  const specs = {};

  for (const tagId of tagIds) {
    const title = tagTitleMap[tagId];
    if (!title) continue;

    if (title.startsWith('category:')) {
      category = title.split(':')[1];
    } else if (title.startsWith('spec:')) {
      const [, key, ...rest] = title.split(':');
      const rawValue = rest.join(':');
      const normalizedKey = SPEC_KEY_ALIASES[key.toLowerCase()] || key;
      specs[normalizedKey] = parseTagValue(rawValue);
    }
  }

  return { category, specs };
}

function parseTagValue(raw) {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  const asNumber = parseFloat(raw);
  if (!isNaN(asNumber) && String(asNumber) === raw) return asNumber;
  return raw; // bijv. "1-fase" blijft string
}

// Producten ophalen (los getrokken zodat dit parallel met de andere calls kan lopen)
async function getAllProducts() {
  const rawProducts = [];
  let page = 1;
  while (true) {
    const productsResp = await lsFetch(`/products.json?limit=250&page=${page}`);
    const batch = productsResp.products || [];
    rawProducts.push(...batch);
    if (batch.length < 250) break;
    page++;
  }
  return rawProducts;
}

// Voorraad/prijs ophalen en indexeren per product-ID (los getrokken, zie hierboven)
async function getAllVariantsIndexed() {
  const productIdToVariants = {};
  let vPage = 1;
  while (true) {
    const variantsResp = await lsFetch(`/variants.json?limit=250&page=${vPage}`);
    const batch = variantsResp.variants || [];
    for (const v of batch) {
      const pid = v.product?.resource?.id;
      if (!pid) continue;
      if (!productIdToVariants[pid]) productIdToVariants[pid] = [];
      productIdToVariants[pid].push(v);
    }
    if (batch.length < 250) break;
    vPage++;
  }
  return productIdToVariants;
}

async function fetchAndTransformProducts() {
  // ---------------------------------------------------------------------------
  // SNELHEIDSFIX: deze vier datasets (tag-namen, tag-koppelingen, producten,
  // voorraad) zijn onderling onafhankelijk — geen van alle heeft de uitkomst
  // van een ander nodig totdat we ze hieronder combineren. Voorheen liepen ze
  // na elkaar (elk met eigen paginering, dus meerdere Lightspeed-calls op
  // een rij), wat bij een cache-miss een paar seconden wachttijd opleverde.
  // Nu lopen ze parallel via Promise.all — de totale wachttijd wordt bepaald
  // door de traagste van de vier, niet door de som van allemaal.
  // ---------------------------------------------------------------------------
  const [tagTitleMap, productIdToTagIds, rawProducts, productIdToVariants] = await Promise.all([
    getTagTitleMap(),
    getAllProductTagIds(), // BUGFIX: zie toelichting hierboven
    getAllProducts(),
    getAllVariantsIndexed(),
  ]);

  // BUGFIX: 'visibility' is de configuratie-modus ('visible'/'hidden'/'auto'),
  // niet de daadwerkelijke status. Een product op 'auto' met isVisible:true
  // is écht zichtbaar, maar werd hier onterecht uitgesloten. 'isVisible' is
  // het juiste veld om op te filteren.
  const visibleProducts = rawProducts.filter(p => p.isVisible === true);

  const result = [];

  // Herkent een kWh-waarde in een varianttitel, bijv. "Solarbank Max AC - 14KWh" -> 14
  function parseCapacityFromVariantTitle(title) {
    if (!title) return null;
    const m = title.match(/(\d+(?:[.,]\d+)?)\s*k\s*wh/i);
    if (!m) return null;
    return parseFloat(m[1].replace(',', '.'));
  }

  for (const raw of visibleProducts) {
    // 2. Tags voor dit product opzoeken in de vooraf gebouwde index
    //    (BUGFIX: geen losse call meer per product).
    const tagIds = productIdToTagIds[raw.id] || [];
    const { category, specs } = parseCategoryAndSpecs(tagIds, tagTitleMap);
    if (!category) continue; // product heeft nog geen category:-tag -> sla over

    const variants = productIdToVariants[raw.id] || [];

    // ---------------------------------------------------------------------------
    // VARIANT-EXPANSIE — sommige batterijen (bijv. Anker Solarbank MAX AC) zijn
    // uitbreidbaar: één product met meerdere varianten die elk een eigen
    // capaciteit EN prijs hebben (7/14/21/28/35/42 kWh). Voorheen pakten we
    // alleen de eerste variant, waardoor de grotere (en vaak beter passende)
    // uitbreidingen nooit in het advies verschenen. Als we in de varianttitels
    // verschillende kWh-waarden herkennen, tonen we elke variant als eigen
    // keuze-optie i.p.v. ze samen te voegen tot één rij.
    // ---------------------------------------------------------------------------
    const variantCapacities = category === 'batterij'
      ? variants.map(v => parseCapacityFromVariantTitle(v.title)).filter(c => c !== null)
      : [];
    const hasDistinctVariantCapacities = new Set(variantCapacities).size > 1;

    if (hasDistinctVariantCapacities) {
      for (const v of variants) {
        const cap = parseCapacityFromVariantTitle(v.title);
        if (cap === null) continue; // variant zonder herkenbare capaciteit overslaan
        result.push({
          id: `${raw.id}-${v.id}`,
          category,
          name: `${raw.title || raw.fulltitle} (${v.title.replace(/^.*-\s*/, '').trim()})`,
          specs: { ...specs, capaciteitKwh: cap },
          price: parseFloat(v.priceIncl || 0),
          stock: v.stockLevel || 0,
          active: raw.isVisible !== false,
          url: raw.url ? `https://www.solar-outlet.nl/${raw.url}.html` : '#',
          image: raw.image?.src || raw.image?.thumb || null,
        });
      }
      continue; // dit product is al toegevoegd als losse varianten, niet nog eens als geheel
    }

    // 3. Prijs + voorraad zitten op de variant, niet het product — nu uit de
    //    vooraf gebouwde index (BUGFIX: geen losse call meer per product).
    const totalStock = variants.reduce((sum, v) => sum + (v.stockLevel || 0), 0);
    const price = variants.length ? parseFloat(variants[0].priceIncl || 0) : 0;

    result.push({
      id: String(raw.id),
      category,
      name: raw.title || raw.fulltitle,
      specs,
      price,
      stock: totalStock,
      active: raw.isVisible !== false,
      url: raw.url ? `https://www.solar-outlet.nl/${raw.url}.html` : '#',
      image: raw.image?.src || raw.image?.thumb || null, // zit al standaard in de productdata, geen extra call nodig
    });
  }

  return result;
}

// mapCategoryFromFilters() en mapSpecsFromFilters() zijn vervallen —
// category en specs komen nu rechtstreeks uit getParsedTagsForProduct(),
// zie de TAGS ALS DRAGER VAN SPECS-toelichting hierboven.

// ---------------------------------------------------------------------------
// DEBUG-ENDPOINT 4 — toont de ruwe productdata zoals Lightspeed die teruggeeft,
// met name het 'visibility'-veld waarop fetchAndTransformProducts filtert.
// Gebruik: https://jouw-domein/api/debug/product-raw/162286158
// ---------------------------------------------------------------------------
app.get('/api/debug/product-raw/:productId', async (req, res) => {
  try {
    const resp = await lsFetch(`/products/${req.params.productId}.json`);
    res.json(resp);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// DEBUG-ENDPOINT 3 — laat precies zien wat de proxy van de tags van één
// product maakt: welke tag-ID's gevonden zijn, welke titel elke ID heeft,
// en welke category/specs daar uiteindelijk uitrollen. Dit isoleert of het
// probleem in het ophalen zit, of in het interpreteren van de tags.
// Gebruik: https://jouw-domein/api/debug/parsed-tags-for/162286158
// ---------------------------------------------------------------------------
app.get('/api/debug/parsed-tags-for/:productId', async (req, res) => {
  try {
    const targetId = req.params.productId;
    tagCache = { byId: null, fetchedAt: 0 }; // BUGFIX: zie toelichting bij /api/debug/products
    const tagTitleMap = await getTagTitleMap();
    const productIdToTagIds = await getAllProductTagIds();
    const tagIds = productIdToTagIds[targetId] || productIdToTagIds[Number(targetId)] || [];
    const resolvedTitles = tagIds.map(id => ({ tagId: id, title: tagTitleMap[id] ?? '(GEEN TITEL GEVONDEN VOOR DIT ID)' }));
    const { category, specs } = parseCategoryAndSpecs(tagIds, tagTitleMap);
    res.json({ targetId, tagIds, resolvedTitles, resultingCategory: category, resultingSpecs: specs });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// DEBUG-ENDPOINT 2 — checkt of een specifiek product al voorkomt in de
// volledige tags/products-lijst van Lightspeed. Handig om propagatie-
// vertraging te onderscheiden van een echte bug.
// Gebruik: https://jouw-domein/api/debug/tags-for/162286158
// ---------------------------------------------------------------------------
app.get('/api/debug/tags-for/:productId', async (req, res) => {
  try {
    const targetId = req.params.productId;
    const found = [];
    let page = 1;
    let totalScanned = 0;
    while (true) {
      const resp = await lsFetch(`/tags/products.json?limit=250&page=${page}`);
      const assocs = resp.tagsProducts || [];
      totalScanned += assocs.length;
      for (const a of assocs) {
        if (String(a.product?.resource?.id) === String(targetId)) {
          found.push(a);
        }
      }
      if (assocs.length < 250) break;
      page++;
    }
    res.json({ targetId, totalAssociationsScanned: totalScanned, pagesScanned: page, foundAssociations: found });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// DEBUG-ENDPOINT — tijdelijk, handig om te controleren of tags goed doorkomen
// zonder de hele keuzehulp-flow te doorlopen. Verwijder dit voordat je
// definitief live gaat, of zet 'm achter een simpel wachtwoord.
// Gebruik: https://jouw-domein/api/debug/products
// ---------------------------------------------------------------------------
app.get('/api/debug/products', async (req, res) => {
  try {
    cache = { data: null, fetchedAt: 0 };       // forceer verse productdata
    tagCache = { byId: null, fetchedAt: 0 };    // BUGFIX: forceer ook verse tag-naam-vertaling —
                                                  // anders blijven gloednieuwe tag-namen onzichtbaar
                                                  // tot de 30-min cache toevallig verloopt.
    const products = await getLiveProducts();
    res.json({ count: products.length, products });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// ROUTE — dit is wat keuzehulp.html's fetchLiveProducts() straks aanroept
// ---------------------------------------------------------------------------
app.get('/api/keuzehulp/products', async (req, res) => {
  try {
    const products = await getLiveProducts();
    res.json(products);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Kon actueel assortiment niet laden' });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Keuzehulp-proxy draait op poort ${PORT}`));
