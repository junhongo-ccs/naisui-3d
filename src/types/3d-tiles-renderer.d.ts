// 3d-tiles-renderer 0.5.3 exports these at runtime but ships no typings for them.
import { ImageOverlay } from '3d-tiles-renderer/three/plugins';

declare module '3d-tiles-renderer/three/plugins' {

	export class MVTOverlay extends ImageOverlay {

		constructor( options?: {
			url?: string,
			levels?: number,
			resolution?: number,
			getStyle?: ( layer: string, properties: Record<string, unknown> | null ) => {
				fill?: string, stroke?: string, strokeWidth?: number, radius?: number, order?: number, visible?: boolean,
			} | null,
		} );

	}

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
