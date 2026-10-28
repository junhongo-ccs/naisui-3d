// 3d-tiles-renderer 0.5.3 exports TerrainRGBMeshPlugin at runtime but ships no typings for it.
import type { ImageOverlay } from '3d-tiles-renderer/three/plugins';

declare module '3d-tiles-renderer/three/plugins' {

	export class TerrainRGBMeshPlugin {

		constructor( options?: {
			url: string,
			tileDimension?: number,
			maxZoom?: number,
			heightScale?: number,
			overlay?: ImageOverlay | null,
			applyOverlayTexture?: boolean,
			unlit?: boolean,
			projection?: 'ellipsoid' | 'source' | string,
			endCaps?: boolean,
			useRecommendedSettings?: boolean,
		} );

		heightScale: number;
		decodeElevation( r: number, g: number, b: number ): number;

	}

}
