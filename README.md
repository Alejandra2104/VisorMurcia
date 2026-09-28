# Visor Murcia — Datos Abiertos (PWA multiplataforma en GitHub Pages)

Visor tabular y geográfico de [Datos Abiertos de la Región de Murcia](https://datosabiertos.regiondemurcia.es).
App **multiplataforma e instalable (PWA)** desplegada como web **estática en GitHub Pages** (sin servidor).

🌐 Demo Pages: `https://Alejandra2104.github.io/VisorMurcia/`

## Por qué versión estática

`server.js` (Express) **no puede correr en GitHub Pages** (Pages solo sirve HTML/CSS/JS).
Por eso `index.html` de la raíz es 100 % frontend:

- Catálogo: lee `./datasets.json` (generado por Actions, mismo origen → sin CORS).
  Fallback en vivo a CKAN con proxies CORS (`corsproxy.io`, `allorigins`).
- Recursos: se descargan y parsean en el navegador:
  - KML/XML → `toGeoJSON` + Leaflet
  - KMZ → `JSZip` + `toGeoJSON`
  - SHP en ZIP → `shpjs` + `proj4` (UTM 30N → WGS84)
  - XLS/XLSX → `SheetJS`
  - CSV/JSON/DataStore → `fetch` directo
  - WMS → enlace/visor
- PWA: `manifest.webmanifest` + `sw.js` + iconos → instalable en Android, iOS (Añadir a inicio), Windows, macOS, Linux. Funciona offline (app shell en caché).

## Desarrollo local

```powershell
npm install
npm start          # http://localhost:3000 (usa public/index.html + API Express)
# o solo estático:
npx serve .        # http://localhost:3000/index.html (modo Pages, sin /api)
```

`server.js` se mantiene para desarrollo local con `/api/*`, pero Pages lo ignora.

## Despliegue en Pages (automático)

1. Push a `main` → workflow `.github/workflows/pages.yml`:
   - Ejecuta `node scripts/build-catalog.mjs ./datasets.json`
   - Publica la raíz en GitHub Pages.
2. Activar una vez en GitHub: **Settings → Pages → Source: GitHub Actions**.
3. El catálogo se refresca a diario con `.github/workflows/update-catalog.yml`.

## Estructura

```
index.html              # App Pages (frontend-only, PWA) ← la que se publica
public/index.html       # Copia para `npm start` (Express sirve /public)
manifest.webmanifest    # PWA instalable
sw.js                   # Service Worker (offline)
icons/icon-192.png, icons/icon-512.png
datasets.json           # Generado por Actions (no editar a mano)
scripts/build-catalog.mjs  # Replica /api/datasets de server.js sin servidor
server.js               # Solo dev local (no se usa en Pages)
.github/workflows/pages.yml
.github/workflows/update-catalog.yml
```
