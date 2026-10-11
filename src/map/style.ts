/**
 * A deliberately quiet dark basemap (OpenFreeMap / OpenMapTiles vector tiles)
 * so the weather colours carry the map, like Apple Weather. The weather layer
 * is inserted below `hillshade`; water is drawn above it so coastlines stay
 * crisp at every zoom (and, in climate mode, so results are clipped to land).
 */
import type { StyleSpecification } from 'maplibre-gl';

export const WEATHER_BEFORE = 'hillshade';
const NAME = ['coalesce', ['get', 'name:en'], ['get', 'name_en'], ['get', 'name']];

export function baseStyle(): StyleSpecification {
  return {
    version: 8,
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    projection: { type: 'mercator' },
    sources: {
      omt: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' },
      dem: {
        type: 'raster-dem',
        tiles: ['https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png'],
        encoding: 'terrarium',
        tileSize: 256,
        maxzoom: 11,
        attribution: 'Terrain: <a href="https://registry.opendata.aws/terrain-tiles/">AWS Terrain Tiles</a>',
      },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#0c111c' } },
      {
        id: 'hillshade',
        type: 'hillshade',
        source: 'dem',
        paint: {
          'hillshade-exaggeration': ['interpolate', ['linear'], ['zoom'], 1, 0.55, 6, 0.4, 10, 0.3],
          'hillshade-shadow-color': 'rgba(8,10,20,0.55)',
          'hillshade-highlight-color': 'rgba(255,255,255,0.10)',
          'hillshade-accent-color': 'rgba(0,0,0,0.15)',
          'hillshade-illumination-direction': 315,
        },
      },
      {
        id: 'water',
        type: 'fill',
        source: 'omt',
        'source-layer': 'water',
        filter: ['!=', ['get', 'brunnel'], 'tunnel'],
        paint: { 'fill-color': '#0a0f19', 'fill-opacity': 0.22, 'fill-antialias': true },
      },
      {
        id: 'coastline',
        type: 'line',
        source: 'omt',
        'source-layer': 'water',
        filter: ['!=', ['get', 'class'], 'swimming_pool'],
        paint: {
          'line-color': 'rgba(255,255,255,0.28)',
          'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.4, 6, 0.8, 10, 1.2],
        },
      },
      {
        id: 'waterway',
        type: 'line',
        source: 'omt',
        'source-layer': 'waterway',
        minzoom: 6,
        paint: { 'line-color': 'rgba(150,180,220,0.25)', 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.4, 12, 1.5] },
      },
      {
        id: 'roads',
        type: 'line',
        source: 'omt',
        'source-layer': 'transportation',
        minzoom: 6,
        filter: ['match', ['get', 'class'], ['motorway', 'trunk', 'primary'], true, false],
        paint: {
          'line-color': 'rgba(255,255,255,0.16)',
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
          'line-color': 'rgba(255,255,255,0.22)',
          'line-dasharray': [2, 2],
          'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.4, 10, 1.2],
        },
      },
      {
        id: 'boundary-country',
        type: 'line',
        source: 'omt',
        'source-layer': 'boundary',
        filter: ['all', ['==', ['get', 'admin_level'], 2], ['!=', ['get', 'maritime'], 1]],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': 'rgba(255,255,255,0.42)',
          'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.5, 5, 1, 10, 2],
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
        paint: { 'text-color': 'rgba(200,215,235,0.45)' },
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
        paint: { 'text-color': 'rgba(255,255,255,0.5)', 'text-halo-color': 'rgba(0,0,0,0.45)', 'text-halo-width': 1 },
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
          'text-color': 'rgba(255,255,255,0.62)',
          'text-halo-color': 'rgba(0,0,0,0.5)',
          'text-halo-width': 1.2,
        },
      },
    ],
  };
}
