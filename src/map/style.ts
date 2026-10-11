/**
 * A light, quiet basemap (OpenFreeMap / OpenMapTiles vector tiles) so the
 * weather colours carry the map, like Apple Weather. The weather layer is
 * inserted below `hillshade`; water is drawn above it so coastlines stay crisp
 * at every zoom (and, in climate mode, so results are clipped to land).
 *
 * Terrain shading uses the `landdem://` protocol (see localDem.ts), which
 * flattens the sea floor so oceans stay smooth.
 */
import type { StyleSpecification } from 'maplibre-gl';
import { GLACIER } from './palettes';

export const WEATHER_BEFORE = 'hillshade';
export const LAND = '#eeefe9';
export const WATER = '#c8d8e4';
const NAME = ['coalesce', ['get', 'name:en'], ['get', 'name_en'], ['get', 'name']];
const INK = '#2c2f33';

export function baseStyle(coastlineUrl: string): StyleSpecification {
  return {
    version: 8,
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    projection: { type: 'mercator' },
    sources: {
      omt: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' },
      coast: { type: 'geojson', data: coastlineUrl, maxzoom: 6, tolerance: 0.5 },
      dem: {
        type: 'raster-dem',
        tiles: ['landdem://{z}/{x}/{y}'],
        encoding: 'terrarium',
        tileSize: 256,
        maxzoom: 11,
        attribution: 'Terrain: <a href="https://registry.opendata.aws/terrain-tiles/">AWS Terrain Tiles</a>',
      },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': LAND } },
      {
        id: 'hillshade',
        type: 'hillshade',
        source: 'dem',
        paint: {
          'hillshade-exaggeration': ['interpolate', ['linear'], ['zoom'], 1, 0.5, 6, 0.38, 10, 0.3],
          'hillshade-shadow-color': 'rgba(40,48,60,0.42)',
          'hillshade-highlight-color': 'rgba(255,255,255,0.32)',
          'hillshade-accent-color': 'rgba(40,48,60,0.12)',
          'hillshade-illumination-direction': 315,
        },
      },
      {
        // permanent ice, shown with the snow-depth layer (Natural Earth at low zoom, OSM glaciers above)
        id: 'glaciers',
        type: 'fill',
        source: 'omt',
        'source-layer': 'landcover',
        filter: ['==', ['get', 'class'], 'ice'],
        layout: { visibility: 'none' },
        paint: { 'fill-color': GLACIER, 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 3, 0.75, 10, 0.6], 'fill-antialias': true },
      },
      {
        id: 'water',
        type: 'fill',
        source: 'omt',
        'source-layer': 'water',
        filter: ['!=', ['get', 'brunnel'], 'tunnel'],
        paint: { 'fill-color': WATER, 'fill-opacity': 0.18, 'fill-antialias': true },
      },
      {
        // low zooms: real coastline lines (tile ocean polygons have a false edge at 180°)
        id: 'coastline-ne',
        type: 'line',
        source: 'coast',
        maxzoom: 5,
        paint: { 'line-color': 'rgba(60,80,100,0.45)', 'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.5, 5, 0.8] },
      },
      {
        id: 'coastline',
        type: 'line',
        source: 'omt',
        'source-layer': 'water',
        minzoom: 5,
        filter: ['!=', ['get', 'class'], 'swimming_pool'],
        paint: {
          'line-color': 'rgba(60,80,100,0.45)',
          'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.8, 10, 1.2],
        },
      },
      {
        id: 'waterway',
        type: 'line',
        source: 'omt',
        'source-layer': 'waterway',
        minzoom: 6,
        paint: { 'line-color': 'rgba(70,110,150,0.35)', 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.4, 12, 1.5] },
      },
      {
        id: 'roads',
        type: 'line',
        source: 'omt',
        'source-layer': 'transportation',
        minzoom: 6,
        filter: ['match', ['get', 'class'], ['motorway', 'trunk', 'primary'], true, false],
        paint: {
          'line-color': 'rgba(60,60,70,0.22)',
          'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.4, 12, 2],
        },
      },
      {
        id: 'boundary-state',
        type: 'line',
        source: 'omt',
        'source-layer': 'boundary',
        minzoom: 3,
        filter: ['all', ['==', ['get', 'admin_level'], 4], ['!=', ['get', 'maritime'], 1]],
        paint: {
          'line-color': 'rgba(50,50,60,0.32)',
          'line-dasharray': [2, 2],
          'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.5, 10, 1.3],
        },
      },
      {
        id: 'boundary-country',
        type: 'line',
        source: 'omt',
        'source-layer': 'boundary',
        filter: ['all', ['==', ['get', 'admin_level'], 2], ['!=', ['get', 'maritime'], 1], ['!=', ['get', 'disputed'], 1], ['!', ['has', 'claimed_by']]],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': 'rgba(45,45,55,0.55)',
          'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.6, 5, 1.1, 10, 2],
        },
      },
      {
        id: 'water-name',
        type: 'symbol',
        source: 'omt',
        'source-layer': 'water_name',
        filter: ['==', ['get', 'class'], 'ocean'],
        layout: {
          'text-field': NAME as never,
          'text-font': ['Noto Sans Italic'],
          'text-size': 12,
          'text-letter-spacing': 0.2,
        },
        paint: { 'text-color': 'rgba(50,80,110,0.6)', 'text-halo-color': 'rgba(255,255,255,0.5)', 'text-halo-width': 1 },
      },
      {
        id: 'place-state',
        type: 'symbol',
        source: 'omt',
        'source-layer': 'place',
        minzoom: 4,
        maxzoom: 9,
        filter: ['==', ['get', 'class'], 'state'],
        layout: {
          'text-field': NAME as never,
          'text-font': ['Noto Sans Regular'],
          'text-size': 10,
          'text-transform': 'uppercase',
          'text-letter-spacing': 0.12,
        },
        paint: { 'text-color': 'rgba(44,47,51,0.6)', 'text-halo-color': 'rgba(255,255,255,0.7)', 'text-halo-width': 1.2 },
      },
      {
        id: 'place-country',
        type: 'symbol',
        source: 'omt',
        'source-layer': 'place',
        maxzoom: 7,
        filter: ['==', ['get', 'class'], 'country'],
        layout: {
          'text-field': NAME as never,
          'text-font': ['Noto Sans Bold'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 1, 9, 4, 13, 6, 15],
          'text-transform': 'uppercase',
          'text-letter-spacing': 0.15,
          'text-max-width': 7,
        },
        paint: {
          'text-color': 'rgba(44,47,51,0.72)',
          'text-halo-color': 'rgba(255,255,255,0.75)',
          'text-halo-width': 1.4,
        },
      },
    ],
  };
}

export { INK };
