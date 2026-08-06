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
// STATIC HOSTING — serveert keuzehulp.html vanaf dezelfde server als de API.
// Zet keuzehulp.html in dezelfde map als dit bestand (server.js).
// Resultaat: https://jouw-domein.nl/keuzehulp.html
// Voordeel: same-origin met /api/keuzehulp/products, dus geen CORS nodig.
// ---------------------------------------------------------------------------
app.use(express.static(path.join(__dirname)));

// ---------------------------------------------------------------------------
// CONFIG — zet deze in environment variables, nooit hardcoded in git
// BEVESTIGD via developers.lightspeedhq.com: EU1-cluster voor .webshopapp.com
// shops is altijd https://api.webshopapp.com/{taal}/ — dus NIET het eigen
// shop-subdomein. Jullie shop wordt herkend via de key/secret zelf.
// ---------------------------------------------------------------------------
const LIGHTSPEED_API_BASE = process.env.LIGHTSPEED_API_BASE || 'https://api.webshopapp.com/nl';
const API_KEY    = process.env.LIGHTSPEED_API_KEY;
const API_SECRET = process.env.LIGHTSPEED_API_SECRET;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minuten — pas aan naar wens

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

async function getLiveProducts() {
  const now = Date.now();
  if (cache.data && (now - cache.fetchedAt) < CACHE_TTL_MS) {
    return cache.data;
  }

  const products = await fetchAndTransformProducts();
  cache = { data: products, fetchedAt: now };
  return products;
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
const TAG_CACHE_TTL_MS = 30 * 60 * 1000;

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

async function fetchAndTransformProducts() {
  const tagTitleMap = await getTagTitleMap();
  const productIdToTagIds = await getAllProductTagIds(); // BUGFIX: zie toelichting hierboven

  // 1. Haal ALLE zichtbare producten op — BUGFIX: dit haalde eerder alleen
  //    de eerste 250 op (?limit=250, zonder paginering). Bij 992 producten
  //    in de shop viel een deel buiten die eerste pagina, waardoor sommige
  //    getagde producten nooit werden meegenomen. Nu volledig gepagineerd.
  const rawProducts = [];
  let page = 1;
  while (true) {
    const productsResp = await lsFetch(`/products.json?limit=250&page=${page}`);
    const batch = productsResp.products || [];
    rawProducts.push(...batch);
    if (batch.length < 250) break;
    page++;
  }
  // BUGFIX: 'visibility' is de configuratie-modus ('visible'/'hidden'/'auto'),
  // niet de daadwerkelijke status. Een product op 'auto' met isVisible:true
  // is écht zichtbaar, maar werd hier onterecht uitgesloten. 'isVisible' is
  // het juiste veld om op te filteren.
  const visibleProducts = rawProducts.filter(p => p.isVisible === true);

  const result = [];

  for (const raw of visibleProducts) {
    // 2. Tags voor dit product opzoeken in de vooraf gebouwde index
    //    (BUGFIX: geen losse call meer per product).
    const tagIds = productIdToTagIds[raw.id] || [];
    const { category, specs } = parseCategoryAndSpecs(tagIds, tagTitleMap);
    if (!category) continue; // product heeft nog geen category:-tag -> sla over

    // 3. Prijs + voorraad zitten op de variant, niet het product.
    //    BEVESTIGD: GET /variants.json?product={id} → priceIncl, stockLevel.
    const variantsResp = await lsFetch(`/variants.json?product=${raw.id}`);
    const variants = variantsResp.variants || [];
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
