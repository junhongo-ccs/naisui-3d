// Builds src/data/names/<city code>.json: the place names shown over the plain map on /plateau.
// The map is drawn without text (src/plain-map.ts), since text inside a map image can't keep the
// type scale's sizes; the names go up as labels instead. They come from OpenStreetMap, by way of
// OpenFreeMap's tiles, within the city's AREA. `range` is how far away a name still shows, in
// meters: the larger, the more it matters, so towns show from afar and schools only close up.
// Each name gets its ground elevation (GSI DEM API, meters above the geoid).
//
//   node --use-system-ca scripts/build-names.mjs [city code]   (default 14204, Kamakura)

import { writeFile, mkdir } from 'node:fs/promises';
import { VectorTile } from '@mapbox/vector-tile';
import Protobuf from 'pbf';

const TILEJSON = 'https://tiles.openfreemap.org/planet';
const ELEVATION_URL = 'https://cyberjapandata2.gsi.go.jp/general/dem/scripts/getelevation.php';
// OpenFreeMap asks that downloads say who they are.
const HEADERS = { 'User-Agent': 'naisui-3d-build-names/1 (https://github.com/junhongo-ccs/naisui-3d)' };
const ZOOM = 14; // the tiles' finest

// [west, south, east, north], as in src/config.ts.
const AREA = { 14204: [ 139.530, 35.302, 139.572, 35.342 ] };

const TOWN_RANGE = 6000, NATURE_RANGE = 3000, ROAD_RANGE = 1500, POI_RANGE = 1000; // m
const POI_CLASSES = new Set( [ 'railway', 'town_hall', 'school', 'college', 'hospital', 'library', 'museum' ] );
const SHRINE_NAME = /(寺|宮|神社|社)$/; // of the many places of worship: not the sub-temples (庵), halls, graves
const NOT_POI = /幼稚園|保育|こども|子ども|眼科|歯科|医院|クリニック/;
const ROAD_NAME = /.(通り|大路|小路|切通|線|街道|隧道|トンネル)$|^国道/;
const NOT_WATER = /配水池/;
const TOWN_CLASSES = new Set( [ 'suburb', 'quarter', 'neighbourhood', 'village', 'town' ] );

const sleep = ms => new Promise( r => setTimeout( r, ms ) );
const tileX = ( lon, z ) => Math.floor( ( lon + 180 ) / 360 * 2 ** z );
const tileY = ( lat, z ) => {

	const r = lat * Math.PI / 180;
	return Math.floor( ( 1 - Math.log( Math.tan( r ) + 1 / Math.cos( r ) ) / Math.PI ) / 2 * 2 ** z );

};

// The name to show: Japanese where the map has it, and nothing for a name only in Latin letters.
function nameOf( p ) {

	// 小町一丁目 → 小町: one name per town.
	const name = ( p[ 'name:ja' ] || p.name )?.replace( /[一二三四五六七八九十]+丁目$/, '' );
	return name && /[^\x00-\x7f]/.test( name ) ? name : null;

}

// How far away a feature's name shows, or 0 to leave it out.
function rangeOf( layer, p, name ) {

	switch ( layer ) {

		case 'place': return TOWN_CLASSES.has( p.class ) ? TOWN_RANGE : 0;
		case 'mountain_peak': case 'waterway': return NATURE_RANGE;
		case 'water_name': return NOT_WATER.test( name ) ? 0 : NATURE_RANGE;
		case 'transportation_name': return ROAD_NAME.test( name ) ? ROAD_RANGE : 0;
		case 'poi': return ! NOT_POI.test( name ) && ( POI_CLASSES.has( p.class ) || ( p.class === 'place_of_worship' && SHRINE_NAME.test( name ) ) ) ? POI_RANGE : 0;
		default: return 0;

	}

}

// One spot for a feature: the point itself, or the middle of a line.
function spot( { type, coordinates } ) {

	if ( type === 'Point' ) return coordinates;
	if ( type === 'MultiPoint' ) return coordinates[ 0 ];
	const line = type === 'LineString' ? coordinates : coordinates.reduce( ( a, b ) => ( a.length >= b.length ? a : b ) );
	return line[ Math.floor( line.length / 2 ) ];

}

async function collect( [ west, south, east, north ] ) {

	const tilejson = await ( await fetch( TILEJSON, { headers: HEADERS } ) ).json();
	const middle = [ ( west + east ) / 2, ( south + north ) / 2 ];
	const byName = new Map();
	for ( let x = tileX( west, ZOOM ); x <= tileX( east, ZOOM ); x ++ ) {

		for ( let y = tileY( north, ZOOM ); y <= tileY( south, ZOOM ); y ++ ) {

			const url = tilejson.tiles[ 0 ].replace( '{z}', ZOOM ).replace( '{x}', x ).replace( '{y}', y );
			const res = await fetch( url, { headers: HEADERS } );
			if ( ! res.ok ) throw new Error( `${ res.status } ${ url }` );
			const tile = new VectorTile( new Protobuf( new Uint8Array( await res.arrayBuffer() ) ) );
			for ( const [ layerName, layer ] of Object.entries( tile.layers ) ) {

				for ( let i = 0; i < layer.length; i ++ ) {

					const feature = layer.feature( i );
					const name = nameOf( feature.properties );
					const range = name ? rangeOf( layerName, feature.properties, name ) : 0;
					if ( ! range ) continue;
					const [ lon, lat ] = spot( feature.toGeoJSON( x, y, ZOOM ).geometry );
					if ( lon < west || lon > east || lat < south || lat > north ) continue;
					// A name found twice (a road across tiles): the wider range, nearest the middle.
					const seen = byName.get( name );
					const off = Math.hypot( lon - middle[ 0 ], lat - middle[ 1 ] );
					if ( ! seen || range > seen.range || ( range === seen.range && off < seen.off ) ) byName.set( name, { name, lat, lon, range, layer: layerName, off } );

				}

			}

			await sleep( 300 );

		}

	}

	return [ ...byName.values() ];

}

async function elevationAt( { lat, lon } ) {

	await sleep( 300 );
	const res = await fetch( `${ ELEVATION_URL }?lon=${ lon }&lat=${ lat }&outtype=JSON` );
	const elevation = Number( ( await res.json() ).elevation );
	return Number.isFinite( elevation ) ? elevation : 0; // '-----' out at sea

}

async function main() {

	const code = process.argv[ 2 ] ?? '14204';
	const found = await collect( AREA[ code ] );
	found.sort( ( a, b ) => b.range - a.range || a.off - b.off );
	const names = [];
	for ( const { name, lat, lon, range } of found ) {

		names.push( {
			kind: 'landmark', name, town: '',
			lat: Number( lat.toFixed( 6 ) ), lon: Number( lon.toFixed( 6 ) ),
			elevation: await elevationAt( { lat, lon } ), range,
		} );

	}

	const out = new URL( `../src/data/names/${ code }.json`, import.meta.url );
	await mkdir( new URL( '.', out ), { recursive: true } );
	await writeFile( out, JSON.stringify( { generatedAt: new Date().toISOString(), names }, null, '\t' ) + '\n' );
	const counts = {};
	for ( const f of found ) counts[ f.layer ] = ( counts[ f.layer ] ?? 0 ) + 1;
	console.log( `${ code }: ${ names.length } names`, counts );

}

main();
