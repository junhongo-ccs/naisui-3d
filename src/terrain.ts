import { TilesRenderer } from '3d-tiles-renderer/three';
import { TerrainRGBMeshPlugin, XYZTilesOverlay } from '3d-tiles-renderer/three/plugins';

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

const DEM_URL = 'https://cyberjapandata.gsi.go.jp/xyz/dem_png/';

// GSI answers 404 for DEM tiles with no land (open sea, and all of z0). The terrain plugin fetches
// with the global fetch, so swap those misses for a "no data" tile that decodes to sea level.
let noDataTile: Promise<Blob> | null = null;
const nativeFetch = window.fetch.bind( window );
window.fetch = async ( input, init ) => {

	const res = await nativeFetch( input, init );
	const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
	if ( res.ok || ! url.startsWith( DEM_URL ) ) return res;

	noDataTile ??= ( () => {

		const canvas = new OffscreenCanvas( 256, 256 );
		const ctx = canvas.getContext( '2d' )!;
		ctx.fillStyle = 'rgb(128,0,0)';
		ctx.fillRect( 0, 0, 256, 256 );
		return canvas.convertToBlob( { type: 'image/png' } );

	} )();
	return new Response( await noDataTile, { headers: { 'Content-Type': 'image/png' } } );

};

export const BASE_MAPS = {
	photo: { label: '航空写真', url: 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg', levels: 18 },
	pale: { label: '淡色地図', url: 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', levels: 18 },
	std: { label: '標準地図', url: 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', levels: 18 },
} as const;

export type BaseMapKey = keyof typeof BASE_MAPS;

export function createTerrain( geoidHeight: number, baseMap: BaseMapKey ): TilesRenderer {

	const { url, levels } = BASE_MAPS[ baseMap ];
	const tiles = new TilesRenderer();
	tiles.registerPlugin( new GSITerrainPlugin( {
		url: `${ DEM_URL }{z}/{x}/{y}.png`,
		maxZoom: 14,
		geoidHeight,
		overlay: new XYZTilesOverlay( { url, levels } ),
		applyOverlayTexture: true,
	} ) );
	return tiles;

}
