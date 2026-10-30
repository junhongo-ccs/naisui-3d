import { TilesRenderer, type OBB } from '3d-tiles-renderer/three';
import type { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { GoogleCloudAuthPlugin } from '3d-tiles-renderer/core/plugins';
import { GLTFExtensionsPlugin, LoadRegionPlugin, OBBRegion, TerrainRGBMeshPlugin, XYZTilesOverlay } from '3d-tiles-renderer/three/plugins';

// GSI elevation PNG tiles (https://maps.gsi.go.jp/development/demtile.html).
// Encoding: x = R·2^16 + G·2^8 + B; h = x·0.01 m, two's complement at 2^23, and 2^23 = no data (sea).
class GSITerrainPlugin extends TerrainRGBMeshPlugin {

	geoidHeight: number;

	constructor( options: ConstructorParameters<typeof TerrainRGBMeshPlugin>[ 0 ] & { geoidHeight: number } ) {

		super( options );
		this.geoidHeight = options.geoidHeight;

	}

	// GSI heights are above the geoid; PLATEAU tiles are above the ellipsoid.
	decodeElevation( r: number, g: number, b: number ): number {

		const x = r * 65536 + g * 256 + b;
		if ( x === 8388608 ) return this.geoidHeight;
		const h = ( x < 8388608 ? x : x - 16777216 ) * 0.01;
		return h + this.geoidHeight;

	}

}

const GSI_XYZ = 'https://cyberjapandata.gsi.go.jp/xyz/';
const DEM_URL = `${ GSI_XYZ }dem_png/`;

// A 256 px PNG filled with one color.
function solidTile( color: string ): Promise<Blob> {

	const canvas = new OffscreenCanvas( 256, 256 );
	const ctx = canvas.getContext( '2d' )!;
	ctx.fillStyle = color;
	ctx.fillRect( 0, 0, 256, 256 );
	return canvas.convertToBlob( { type: 'image/png' } );

}

// GSI answers 404 (with an XML body) for tiles it doesn't have: DEM tiles with no land (open sea,
// and all of z0), and z0–1 of the aerial photo and pale maps, plus their tiles out at sea. Either
// miss fails the whole terrain tile, the root included, so nothing shows. The terrain plugin and
// the overlay fetch with the global fetch, so swap the misses: DEM for a "no data" tile that decodes
// to sea level, base maps for a plain light gray one (transparent would show black while the
// finer tiles load).
let noDataTile: Promise<Blob> | null = null;
let blankTile: Promise<Blob> | null = null;
const nativeFetch = window.fetch.bind( window );
window.fetch = async ( input, init ) => {

	const res = await nativeFetch( input, init );
	const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
	if ( res.ok || ! url.startsWith( GSI_XYZ ) ) return res;

	const tile = url.startsWith( DEM_URL ) ? ( noDataTile ??= solidTile( 'rgb(128,0,0)' ) ) : ( blankTile ??= solidTile( '#c9ccc4' ) );
	return new Response( await tile, { headers: { 'Content-Type': 'image/png' } } );

};

export const BASE_MAPS = {
	photo: { label: '航空写真', url: 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg', levels: 18 },
	pale: { label: '淡色地図', url: 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', levels: 18 },
	std: { label: '標準地図', url: 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', levels: 18 },
} as const;

export type BaseMapKey = keyof typeof BASE_MAPS;

// Load and show only the tiles inside `area` (an OBB in ECEF, the frame the tiles are in).
// Unbounded, a view toward the horizon asks for thousands of tiles out to the edge of the globe;
// decoding them ties up the parse queue that the buildings and floods share, so those never
// load. It also keeps the view to the one city. The region's error target is infinite so that
// only the camera decides how fine to load; the region just masks.
function maskTo( tiles: TilesRenderer, area: OBB ) {

	const region = new LoadRegionPlugin();
	region.addRegion( new OBBRegion( { obb: area, mask: true, errorTarget: Infinity } ) );
	tiles.registerPlugin( region );

}

export function createTerrain( geoidHeight: number, baseMap: BaseMapKey, area: OBB ): TilesRenderer {

	const { url, levels } = BASE_MAPS[ baseMap ];
	const tiles = new TilesRenderer();
	maskTo( tiles, area );
	tiles.registerPlugin( new GSITerrainPlugin( {
		url: `${ DEM_URL }{z}/{x}/{y}.png`,
		maxZoom: 14,
		geoidHeight,
		overlay: new XYZTilesOverlay( { url, levels } ),
		applyOverlayTexture: true,
	} ) );
	return tiles;

}

// Google Photorealistic 3D Tiles: ground, buildings and trees as one textured mesh, in place of
// the GSI terrain and the PLATEAU buildings. Its tiles go from coarse to fine with distance, so a
// view over the city loads far less than the PLATEAU buildings do. Needs a Map Tiles API key; the
// page must show the tiles' attributions (getAttributions).
export function createGoogleTiles( apiKey: string, area: OBB, dracoLoader: DRACOLoader ): TilesRenderer {

	const tiles = new TilesRenderer();
	tiles.registerPlugin( new GoogleCloudAuthPlugin( { apiToken: apiKey, autoRefreshToken: true } ) );
	tiles.registerPlugin( new GLTFExtensionsPlugin( { dracoLoader } ) );
	maskTo( tiles, area );
	return tiles;

}
