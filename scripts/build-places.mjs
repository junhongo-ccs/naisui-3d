// Builds src/data/places/<city code>.json: the pins shown over a city.
//   - shelters: 指定避難所 (designated shelters) registered by the city with GSI
//   - landmarks: stations, shrines, beaches… looked up by name with the GSI place-name search,
//     so the user can tell where they are in VR
// Each place gets its town name (GSI reverse geocoder) and ground elevation (GSI DEM API, meters
// above the geoid), so the viewer can stand pins on the ground without raycasting the terrain.
//
//   node --use-system-ca scripts/build-places.mjs [city code]   (default 14204, Kamakura)

import { writeFile, mkdir } from 'node:fs/promises';

const SHELTER_CSV = code => `https://hinanmap.gsi.go.jp/hinanjocp/defaultFtpData/csv/${ code }_1.csv`;
const SEARCH_URL = 'https://msearch.gsi.go.jp/address-search/AddressSearch?q=';
const REVERSE_URL = 'https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress';
const ELEVATION_URL = 'https://cyberjapandata2.gsi.go.jp/general/dem/scripts/getelevation.php';

// Landmarks per city: the label to show, the search word (default: the label), and the title of
// the search hit to take (default: the search word). Where the search's point is off (it can be
// a few hundred meters from the place, or inside a building beside a street), `at` gives
// [lat, lon] instead, taken from OpenStreetMap.
const LANDMARKS = {
	14204: [
		{ name: '鎌倉駅', at: [ 35.3190, 139.5507 ] }, // the station building; the search's point is 210 m west
		{ name: '若宮大路', at: [ 35.32056, 139.55312 ] }, // on the street at 小町; the search's point is 70 m west, in a building
		{ name: '北鎌倉駅' },
		{ name: '大船駅' },
		{ name: '長谷駅' },
		{ name: '鎌倉高校前駅' },
		{ name: '鶴岡八幡宮' },
		{ name: '鎌倉大仏（高徳院）', query: '高徳院' },
		{ name: '建長寺', query: '建長寺', title: '建長寺境内・庭園' },
		{ name: '円覚寺' },
		{ name: '鎌倉宮' },
		{ name: '由比ヶ浜' },
		{ name: '材木座海岸' },
		{ name: '七里ヶ浜' },
		{ name: '稲村ヶ崎' },
		{ name: '滑川（河口）', query: '滑川', title: '滑川' },
	],
};

const sleep = ms => new Promise( r => setTimeout( r, ms ) );

async function getJSON( url ) {

	for ( let attempt = 0; ; attempt ++ ) {

		const res = await fetch( url );
		if ( res.ok ) return res.json();
		if ( attempt >= 3 ) throw new Error( `${ res.status } ${ url }` );
		await sleep( 2000 * ( attempt + 1 ) );

	}

}

// The CSV is UTF-8 with a BOM; Shift_JIS is the older form some cities still upload.
async function getShelters( code ) {

	const res = await fetch( SHELTER_CSV( code ) );
	if ( ! res.ok ) throw new Error( `${ res.status } ${ SHELTER_CSV( code ) }` );
	const bytes = new Uint8Array( await res.arrayBuffer() );
	const text = new TextDecoder( bytes[ 0 ] === 0xef ? 'utf-8' : 'shift_jis' ).decode( bytes ).replace( /^﻿/, '' );
	const [ header, ...rows ] = text.split( /\r?\n/ ).filter( Boolean ).map( l => l.split( ',' ) );
	const col = name => header.indexOf( name );
	return rows.map( r => ( {
		kind: 'shelter',
		name: r[ col( '施設・場所名' ) ],
		address: r[ col( '住所' ) ],
		lat: Number( r[ col( '緯度' ) ] ),
		lon: Number( r[ col( '経度' ) ] ),
	} ) );

}

async function findLandmark( code, { name, query = name, title = query, at } ) {

	if ( at ) return { kind: 'landmark', name, lat: at[ 0 ], lon: at[ 1 ] };
	const hits = await getJSON( SEARCH_URL + encodeURIComponent( query ) );
	const hit = hits.find( f => f.properties.addressCode === code && f.properties.title === title );
	if ( ! hit ) throw new Error( `no hit for ${ query } (${ title }) in ${ code }` );
	const [ lon, lat ] = hit.geometry.coordinates.map( Number );
	return { kind: 'landmark', name, lat, lon };

}

// Town name and ground elevation. Both APIs are shared public services, so go slowly.
async function describe( place ) {

	await sleep( 300 );
	const town = await getJSON( `${ REVERSE_URL }?lat=${ place.lat }&lon=${ place.lon }` );
	await sleep( 300 );
	const dem = await getJSON( `${ ELEVATION_URL }?lon=${ place.lon }&lat=${ place.lat }&outtype=JSON` );
	const elevation = Number( dem.elevation );
	if ( ! Number.isFinite( elevation ) ) throw new Error( `no elevation at ${ place.name }` );
	return { ...place, town: town.results?.lv01Nm ?? '', elevation };

}

async function main() {

	const code = process.argv[ 2 ] ?? '14204';
	const landmarks = [];
	for ( const l of LANDMARKS[ code ] ?? [] ) {

		landmarks.push( await describe( await findLandmark( code, l ) ) );
		await sleep( 300 );

	}

	const shelters = [];
	for ( const s of await getShelters( code ) ) shelters.push( await describe( s ) );

	const out = new URL( `../src/data/places/${ code }.json`, import.meta.url );
	await mkdir( new URL( '.', out ), { recursive: true } );
	await writeFile( out, JSON.stringify( { generatedAt: new Date().toISOString(), landmarks, shelters }, null, '\t' ) + '\n' );
	console.log( `${ code }: ${ landmarks.length } landmarks, ${ shelters.length } shelters` );

}

main();
