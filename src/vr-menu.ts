import * as THREE from 'three';

export type CityItem = { code: string, pref: string, city: string };

// A panel listing the cities, opened in front of the user and picked with the right-hand ray.
// It is one textured plane: hit-testing is a single ray–plane test plus the hit's UV, cheap enough
// to run every frame.
export function createCityMenu( cities: CityItem[] ) {

	const COLS = 4;
	const ROWS = Math.ceil( cities.length / COLS );
	const PAD = 32, HEADER = 96, CELL_W = 300, CELL_H = 100, GAP = 12;
	const WIDTH = 1.4; // m
	const DISTANCE = 1.4; // m in front of the head

	const canvas = document.createElement( 'canvas' );
	canvas.width = PAD * 2 + COLS * CELL_W + ( COLS - 1 ) * GAP;
	canvas.height = PAD * 2 + HEADER + ROWS * CELL_H + ( ROWS - 1 ) * GAP;
	const ctx = canvas.getContext( '2d' )!;
	const texture = new THREE.CanvasTexture( canvas );
	texture.colorSpace = THREE.SRGBColorSpace;
	texture.anisotropy = 4;

	const mesh = new THREE.Mesh(
		new THREE.PlaneGeometry( WIDTH, WIDTH * canvas.height / canvas.width ),
		new THREE.MeshBasicMaterial( { map: texture, transparent: true, depthTest: false } ),
	);
	mesh.renderOrder = 1000;
	mesh.visible = false;

	let current = '';
	let hovered = - 1;

	function cellRect( i: number ) {

		const col = i % COLS, row = Math.floor( i / COLS );
		return { x: PAD + col * ( CELL_W + GAP ), y: PAD + HEADER + row * ( CELL_H + GAP ) };

	}

	function draw() {

		ctx.clearRect( 0, 0, canvas.width, canvas.height );
		ctx.fillStyle = 'rgba(20, 26, 36, 0.92)';
		ctx.beginPath();
		ctx.roundRect( 0, 0, canvas.width, canvas.height, 36 );
		ctx.fill();

		ctx.textBaseline = 'middle';
		ctx.fillStyle = '#ffffff';
		ctx.font = 'bold 44px system-ui, sans-serif';
		ctx.fillText( '市町村を選ぶ', PAD, PAD + HEADER / 2 - 8 );
		ctx.fillStyle = '#9fb3c8';
		ctx.font = '30px system-ui, sans-serif';
		const hint = '右手で指してトリガー　グリップで閉じる';
		ctx.fillText( hint, canvas.width - PAD - ctx.measureText( hint ).width, PAD + HEADER / 2 - 8 );

		cities.forEach( ( c, i ) => {

			const { x, y } = cellRect( i );
			const isCurrent = c.code === current;
			ctx.fillStyle = i === hovered ? '#3f93dc' : isCurrent ? '#1f3f66' : 'rgba(255, 255, 255, 0.08)';
			ctx.beginPath();
			ctx.roundRect( x, y, CELL_W, CELL_H, 16 );
			ctx.fill();
			if ( isCurrent ) {

				ctx.strokeStyle = '#9fd3ff';
				ctx.lineWidth = 4;
				ctx.stroke();

			}

			ctx.fillStyle = i === hovered ? '#e6f3ff' : '#9fb3c8';
			ctx.font = '26px system-ui, sans-serif';
			ctx.fillText( c.pref, x + 20, y + 30 );
			ctx.fillStyle = '#ffffff';
			ctx.font = 'bold 38px system-ui, sans-serif';
			ctx.fillText( c.city, x + 20, y + 68 );

		} );

		texture.needsUpdate = true;

	}

	// Index of the cell under a point on the panel, from its UV (v = 0 at the bottom).
	function cellAt( uv: THREE.Vector2 ): number {

		const px = uv.x * canvas.width, py = ( 1 - uv.y ) * canvas.height;
		for ( let i = 0; i < cities.length; i ++ ) {

			const { x, y } = cellRect( i );
			if ( px >= x && px < x + CELL_W && py >= y && py < y + CELL_H ) return i;

		}

		return - 1;

	}

	const head = new THREE.Vector3();
	const forward = new THREE.Vector3();

	// Put the panel in front of the head, facing it, and carry it along with the rig.
	function open( xrCam: THREE.Camera, rig: THREE.Object3D, currentCode: string ) {

		current = currentCode;
		hovered = - 1;
		draw();
		xrCam.getWorldPosition( head );
		xrCam.getWorldDirection( forward );
		forward.y = 0;
		forward.normalize();
		mesh.removeFromParent();
		mesh.position.copy( head ).addScaledVector( forward, DISTANCE );
		mesh.position.y -= 0.15;
		mesh.lookAt( head );
		rig.attach( mesh );
		mesh.visible = true;

	}

	function close() {

		mesh.visible = false;
		mesh.removeFromParent();
		hovered = - 1;

	}

	// Track the ray over the panel. Returns the distance to the panel, or null if it misses.
	function hover( ray: THREE.Raycaster ): number | null {

		const hit = ray.intersectObject( mesh, false )[ 0 ];
		const i = hit?.uv ? cellAt( hit.uv ) : - 1;
		if ( i !== hovered ) {

			hovered = i;
			draw();

		}

		return hit ? hit.distance : null;

	}

	return {
		open,
		close,
		hover,
		get isOpen() { return mesh.visible; },
		get hoveredCode() { return cities[ hovered ]?.code ?? null; },
	};

}
