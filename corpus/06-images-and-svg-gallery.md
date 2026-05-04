# Images, SVGs, and Inline Figures

A reference document for visual content in md4x: inline SVG, data-URI raster images, captions, sizing, and layout.

## Inline SVG

Inline SVG is the safest way to embed a vector figure: it travels with the document, scales to any DPI, and survives PDF generation without rasterization. md4x renders raw HTML through, so an `<svg>` tag drops straight into the body.

A minimalist diagram:

<p style="text-align:center; margin: 1.4em 0;">
<svg viewBox="0 0 320 200" width="60%" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="arrow" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L0,6 L9,3 z" fill="#1f2937"/>
    </marker>
  </defs>
  <rect x="20"  y="60" width="80" height="80" rx="8" fill="#fef3c7" stroke="#b45309" stroke-width="2"/>
  <rect x="220" y="60" width="80" height="80" rx="8" fill="#dbeafe" stroke="#1d4ed8" stroke-width="2"/>
  <text x="60"  y="105" text-anchor="middle" font-family="Inter,Helvetica,sans-serif" font-size="14" fill="#92400e">Source</text>
  <text x="260" y="105" text-anchor="middle" font-family="Inter,Helvetica,sans-serif" font-size="14" fill="#1e3a8a">Sink</text>
  <line x1="105" y1="100" x2="215" y2="100" stroke="#1f2937" stroke-width="2" marker-end="url(#arrow)"/>
  <text x="160" y="92"  text-anchor="middle" font-family="Inter,Helvetica,sans-serif" font-size="11" fill="#374151">stream</text>
</svg>
</p>

A bar chart with manually placed labels:

<p style="text-align:center; margin: 1.4em 0;">
<svg viewBox="0 0 480 240" width="80%" xmlns="http://www.w3.org/2000/svg">
  <style>
    .axis { stroke: #94a3b8; stroke-width: 1; }
    .label { font-family: Inter, Helvetica, sans-serif; font-size: 11px; fill: #475569; }
    .value { font-family: Inter, Helvetica, sans-serif; font-size: 10px; fill: #0f172a; }
    .bar1 { fill: #1d4ed8; }
    .bar2 { fill: #047857; }
    .bar3 { fill: #b45309; }
    .bar4 { fill: #be123c; }
  </style>
  <line class="axis" x1="50" y1="200" x2="460" y2="200"/>
  <line class="axis" x1="50" y1="20"  x2="50"  y2="200"/>
  <rect class="bar1" x="80"  y="80"  width="60" height="120"/>
  <rect class="bar2" x="170" y="60"  width="60" height="140"/>
  <rect class="bar3" x="260" y="40"  width="60" height="160"/>
  <rect class="bar4" x="350" y="100" width="60" height="100"/>
  <text class="value" x="110" y="74"  text-anchor="middle">12.3</text>
  <text class="value" x="200" y="54"  text-anchor="middle">14.1</text>
  <text class="value" x="290" y="34"  text-anchor="middle">16.0</text>
  <text class="value" x="380" y="94"  text-anchor="middle">10.0</text>
  <text class="label" x="110" y="218" text-anchor="middle">Q1</text>
  <text class="label" x="200" y="218" text-anchor="middle">Q2</text>
  <text class="label" x="290" y="218" text-anchor="middle">Q3</text>
  <text class="label" x="380" y="218" text-anchor="middle">Q4</text>
  <text class="label" x="20"  y="200" text-anchor="end">0</text>
  <text class="label" x="20"  y="120" text-anchor="end">8</text>
  <text class="label" x="20"  y="40"  text-anchor="end">16</text>
</svg>
</p>

## Data-URI Raster

Tiny raster images travel inline as data URIs. Useful for thumbnails, logos, or small status icons. Larger raster content is best handled as external files; we'll cover that in a follow-up document.

A 4x4 PNG checkerboard, scaled up by CSS:

<p style="text-align:center; margin: 1.4em 0;">
<img alt="checkerboard"
     src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFklEQVQYV2NkYGD4z8DAwMgABXAGADQ7Aaph9k36AAAAAElFTkSuQmCC"
     width="120" height="120"
     style="image-rendering: pixelated; border: 1px solid #94a3b8;"/>
</p>

A small logomark composed inline:

<p style="text-align:center; margin: 1.4em 0;">
<svg viewBox="0 0 120 120" width="120" xmlns="http://www.w3.org/2000/svg">
  <circle cx="60" cy="60" r="56" fill="#0c0c0c"/>
  <circle cx="60" cy="60" r="44" fill="none" stroke="#fef3c7" stroke-width="3"/>
  <text x="60" y="68" text-anchor="middle" font-family="Iowan Old Style,Georgia,serif" font-size="38" fill="#fef3c7" font-weight="700">M4</text>
</svg>
</p>

## Side-by-side Figures

Two SVG panels in a row, useful for "before / after" comparisons.

<div style="display:flex; gap: 16px; margin: 1.4em 0; justify-content: space-between;">
<svg viewBox="0 0 200 160" width="48%" xmlns="http://www.w3.org/2000/svg" style="border:1px solid #e5e7eb; background:#f8fafc;">
  <text x="100" y="22" text-anchor="middle" font-family="Inter,sans-serif" font-size="12" fill="#475569">Before</text>
  <circle cx="60"  cy="90" r="22" fill="#dc2626"/>
  <circle cx="100" cy="90" r="22" fill="#dc2626"/>
  <circle cx="140" cy="90" r="22" fill="#dc2626"/>
  <line x1="40" y1="130" x2="160" y2="130" stroke="#1f2937" stroke-width="2"/>
</svg>
<svg viewBox="0 0 200 160" width="48%" xmlns="http://www.w3.org/2000/svg" style="border:1px solid #e5e7eb; background:#f8fafc;">
  <text x="100" y="22" text-anchor="middle" font-family="Inter,sans-serif" font-size="12" fill="#475569">After</text>
  <circle cx="60"  cy="90" r="22" fill="#16a34a"/>
  <circle cx="100" cy="90" r="22" fill="#16a34a"/>
  <circle cx="140" cy="90" r="22" fill="#16a34a"/>
  <line x1="40" y1="130" x2="160" y2="130" stroke="#1f2937" stroke-width="2"/>
</svg>
</div>

## Captioned Figure

A figure with caption uses a `<figure>` element and its `<figcaption>`. CSS styles the caption italic, smaller, and centered.

<figure style="margin: 1.4em 0; text-align:center;">
<svg viewBox="0 0 360 220" width="80%" xmlns="http://www.w3.org/2000/svg">
  <rect x="20" y="20" width="320" height="160" rx="10" fill="#fef9c3" stroke="#a16207"/>
  <circle cx="120" cy="100" r="36" fill="#fbbf24"/>
  <circle cx="240" cy="100" r="36" fill="#fb923c"/>
  <line x1="156" y1="100" x2="204" y2="100" stroke="#1f2937" stroke-width="3"/>
  <text x="180" y="190" text-anchor="middle" font-family="Iowan Old Style,Georgia,serif" font-size="13" fill="#374151" font-style="italic">A schematic of the diffusion process between two reservoirs.</text>
</svg>
<figcaption style="font-family: 'Iowan Old Style', Georgia, serif; font-style: italic; color: #475569; font-size: 10pt; margin-top: 0.4em;">
Figure 1. The classical two-reservoir model. Particles transit at a rate proportional to the concentration difference.
</figcaption>
</figure>

## Mixing SVG with Math

A schematic of a function with annotations rendered through KaTeX:

<p style="text-align:center; margin: 1.4em 0;">
<svg viewBox="0 0 360 200" width="70%" xmlns="http://www.w3.org/2000/svg">
  <line x1="20"  y1="170" x2="340" y2="170" stroke="#94a3b8" stroke-width="1"/>
  <line x1="180" y1="20"  x2="180" y2="180" stroke="#94a3b8" stroke-width="1"/>
  <path d="M 30 150 Q 180 -30 330 150" fill="none" stroke="#1d4ed8" stroke-width="2"/>
  <circle cx="180" cy="40" r="4" fill="#dc2626"/>
  <text x="190" y="44" font-family="Iowan Old Style,Georgia,serif" font-size="12" fill="#0f172a">peak</text>
</svg>
</p>

The curve sketches $y = -\tfrac{1}{1000}(x - 180)^2 + 40$ over the visible interval; the marked point is $(180, 40)$.

## A Floor Plan

Inline SVG also works for arbitrary 2D layouts.

<p style="text-align:center; margin: 1.4em 0;">
<svg viewBox="0 0 480 280" width="80%" xmlns="http://www.w3.org/2000/svg">
  <rect x="10" y="10" width="460" height="260" fill="none" stroke="#1f2937" stroke-width="3"/>
  <line x1="160" y1="10"  x2="160" y2="160" stroke="#1f2937" stroke-width="2"/>
  <line x1="10"  y1="160" x2="320" y2="160" stroke="#1f2937" stroke-width="2"/>
  <line x1="320" y1="10"  x2="320" y2="270" stroke="#1f2937" stroke-width="2"/>
  <text x="85"   y="90"  text-anchor="middle" font-family="Inter,sans-serif" font-size="13" fill="#0f172a">Living</text>
  <text x="240"  y="90"  text-anchor="middle" font-family="Inter,sans-serif" font-size="13" fill="#0f172a">Bedroom</text>
  <text x="160"  y="220" text-anchor="middle" font-family="Inter,sans-serif" font-size="13" fill="#0f172a">Kitchen</text>
  <text x="395"  y="140" text-anchor="middle" font-family="Inter,sans-serif" font-size="13" fill="#0f172a">Patio</text>
  <line x1="155" y1="80"  x2="165" y2="80"  stroke="#16a34a" stroke-width="3"/>
  <line x1="320" y1="160" x2="320" y2="180" stroke="#16a34a" stroke-width="3"/>
</svg>
</p>

## Closing

Vector figures stay sharp regardless of zoom level; raster figures need to be sized appropriately at insertion time. Use SVG by default; reserve raster for photographs, screenshots, and dithered art.
