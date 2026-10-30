import * as THREE from 'three';

// A flat label that stands upright and turns to face the eye's position. Unlike a sprite, it
// ignores which way the head is turned or tilted: in VR a label that rolls and pitches with the
// head is hard to read. `center` is the point of the label at its position, as fractions of its
// size (like Sprite.center; may lie outside 0..1).
export type Billboard = { obj: THREE.Group, mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>, center: THREE.Vector2, aspect: number };
const PLANE = new THREE.PlaneGeometry( 1, 1 );

export function billboard( canvas: HTMLCanvasElement | null, cx: number, cy: number, renderOrder: number ): Billboard {

	const mesh = new THREE.Mesh( PLANE, new THREE.MeshBasicMaterial( { depthTest: false, transparent: true } ) );
	mesh.renderOrder = renderOrder;
	const obj = new THREE.Group();
	obj.add( mesh );
	const b = { obj, mesh, center: new THREE.Vector2( cx, cy ), aspect: 1 };
	if ( canvas ) setTexture( b, canvas );
	return b;

}

export function setTexture( b: Billboard, canvas: HTMLCanvasElement ) {

	const mat = b.mesh.material;
	mat.map?.dispose();
	mat.map = new THREE.CanvasTexture( canvas );
	mat.map.colorSpace = THREE.SRGBColorSpace;
	mat.needsUpdate = true;
	b.aspect = canvas.width / canvas.height;

}

// Stand `b` at `position`, `height` tall, facing `eye`.
export function pose( b: Billboard, position: THREE.Vector3, height: number, eye: THREE.Vector3 ) {

	const w = height * b.aspect;
	b.obj.position.copy( position );
	b.obj.lookAt( eye );
	b.mesh.scale.set( w, height, 1 );
	b.mesh.position.set( ( 0.5 - b.center.x ) * w, ( 0.5 - b.center.y ) * height, 0 );

}

export function disposeBillboard( b: Billboard ) {

	b.mesh.material.map?.dispose();
	b.mesh.material.dispose();

}
