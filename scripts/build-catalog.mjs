// Builds src/data/cities.json from the PLATEAU data catalog API.
// Picks every municipality that has an inland-flood model (ifld) and records
// its flood tilesets, building tilesets, center point and geoid height.
//
//   node scripts/build-catalog.mjs

import { writeFile, mkdir } from 'node:fs/promises';

const CATALOG_URL = 'https://api.plateauview.mlit.go.jp/datacatalog/plateau-datasets';
const GEOID_URL = 'https://vldb.gsi.go.jp/sokuchi/surveycalc/geoid/calcgh/cgi/geoidcalc.pl';
const OUT = new URL( '../src/data/cities.json', import.meta.url );

const toDeg = r => r * 180 / Math.PI;

async function getJSON( url ) {

	const res = await fetch( url );
	if ( ! res.ok ) throw new Error( `${ res.status } ${ url }` );
	return res.json();

}

// The GSI geoid API rejects rapid calls, so pace and retry them.
async function getGeoidHeight( lat, lon ) {

	for ( let attempt = 0; attempt < 5; attempt ++ ) {

		await new Promise( r => setTimeout( r, 1500 * ( attempt + 1 ) ) );
		const json = await getJSON( `${ GEOID_URL }?outputType=json&latitude=${ lat }&longitude=${ lon }` );
		const h = Number( json?.OutputData?.geoidHeight );
		if ( Number.isFinite( h ) ) return h;

	}

	throw new Error( `geoid lookup failed for ${ lat },${ lon }` );

}

// Building tilesets: one per ward for designated cities, otherwise one per city.
// Prefer LOD2 without textures (light but still shaped), then LOD1.
function pickBuildings( datasets ) {

	const score = e => ( e.lod === 2 && ! e.texture ? 0 : e.lod === 1 ? 1 : 2 );
	const byWard = new Map();
	for ( const e of datasets ) {

		const key = e.ward_code ?? '';
		const best = byWard.get( key );
		if ( ! best || score( e ) < score( best ) ) byWard.set( key, e );

	}

	return [ ...byWard.values() ].map( e => ( { name: e.ward ?? e.city, url: e.url } ) );

}

async function main() {

	const { datasets } = await getJSON( CATALOG_URL );
	const floods = datasets.filter( e => e.type_en === 'ifld' && e.format === '3D Tiles' );
	const codes = [ ...new Set( floods.map( e => e.city_code ) ) ];

	const cities = [];
	for ( const code of codes ) {

		const cityFloods = floods.filter( e => e.city_code === code );
		const first = cityFloods[ 0 ];
		const buildings = pickBuildings(
			datasets.filter( e => e.city_code === code && e.type_en === 'bldg' && e.format === '3D Tiles' ),
		);

		// Center the view on the union of the flood tilesets' root regions.
		let [ west, south, east, north, minH ] = [ Infinity, Infinity, - Infinity, - Infinity, Infinity ];
		for ( const e of cityFloods ) {

			const ts = await getJSON( e.url );
			const [ w, s, ea, n, h0 ] = ts.root.boundingVolume.region;
			west = Math.min( west, w ); south = Math.min( south, s );
			east = Math.max( east, ea ); north = Math.max( north, n );
			minH = Math.min( minH, h0 );

		}

		const lat = toDeg( ( south + north ) / 2 );
		const lon = toDeg( ( west + east ) / 2 );
		const geoidHeight = await getGeoidHeight( lat, lon );

		cities.push( {
			code,
			pref: first.pref,
			city: first.city,
			lat: +lat.toFixed( 6 ),
			lon: +lon.toFixed( 6 ),
			// Ellipsoidal height of the lowest flood polygon, used as the local ground origin.
			groundHeight: +minH.toFixed( 2 ),
			// GSI DEM heights are orthometric; PLATEAU 3D Tiles are ellipsoidal.
			geoidHeight: +geoidHeight.toFixed( 3 ),
			bounds: [ west, south, east, north ].map( r => +toDeg( r ).toFixed( 6 ) ),
			floods: cityFloods.map( e => ( {
				id: e.id,
				name: e.name.replace( /^内水浸水想定区域モデル\s*/, '' ).replace( /（[^）]*）$/, '' ),
				year: e.year,
				url: e.url,
			} ) ),
			buildings,
		} );
		console.log( `${ first.pref }${ first.city }: ${ cityFloods.length } flood, ${ buildings.length } building tilesets` );

	}

	await mkdir( new URL( '.', OUT ), { recursive: true } );
	await writeFile( OUT, JSON.stringify( { generatedAt: new Date().toISOString(), cities }, null, '\t' ) + '\n' );
	console.log( `wrote ${ cities.length } cities` );

}

main();
