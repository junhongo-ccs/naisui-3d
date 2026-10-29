import * as THREE from 'three';

// "Loading" shown while the tilesets fetch and parse: a pill at the top of the page, and in VR,
// where the page can't be seen, a turning ring and a card just below the line of sight.
// No percentage: the total grows as tiles come into view, so any figure would mislead.
// Short loads (panning, turning the head) don't flash it: it shows after a moment of loading
// and hides after a moment of quiet.
export function createLoadingIndicator( head: THREE.Camera ) {

	const SHOW_AFTER = 0.3; // s
	const HIDE_AFTER = 0.6; // s

	const el = document.querySelector( '#loading' ) as HTMLElement;

	const vr = new THREE.Group();
	vr.position.set( 0, - 0.22, - 1.2 );
	vr.visible = false;
	head.add( vr );

	const overlay = ( m: THREE.Mesh ) => {

		( m.material as THREE.Material ).depthTest = false;
		m.renderOrder = 1001;
		return m;

	};
	const ring = overlay( new THREE.Mesh(
		new THREE.RingGeometry( 0.011, 0.015, 32, 1, 0, Math.PI * 1.5 ),
		new THREE.MeshBasicMaterial( { color: '#6fb3ec', transparent: true } ),
	) );
	// In the gap left of the text.
	ring.position.set( - 0.077, 0, 0.001 );

	const canvas = document.createElement( 'canvas' );
	canvas.width = 512;
	canvas.height = 112;
	const ctx = canvas.getContext( '2d' )!;
	ctx.fillStyle = 'rgba(20, 26, 36, 0.85)';
	ctx.beginPath();
	ctx.roundRect( 0, 0, canvas.width, canvas.height, 28 );
	ctx.fill();
	ctx.fillStyle = '#ffffff';
	ctx.font = 'bold 44px system-ui, sans-serif';
	ctx.textBaseline = 'middle';
	ctx.fillText( '読み込み中', 120, canvas.height / 2 + 2 );
	const texture = new THREE.CanvasTexture( canvas );
	texture.colorSpace = THREE.SRGBColorSpace;
	const card = overlay( new THREE.Mesh(
		new THREE.PlaneGeometry( 0.2, 0.2 * canvas.height / canvas.width ),
		new THREE.MeshBasicMaterial( { map: texture, transparent: true } ),
	) );
	vr.add( card, ring );

	let busyFor = 0, idleFor = 0;
	let everBusy = false;
	let shown = false;

	function update( dt: number, loading: boolean, inXR: boolean ) {

		busyFor = loading ? busyFor + dt : 0;
		idleFor = loading ? 0 : idleFor + dt;
		everBusy ||= loading;
		if ( ! shown && busyFor >= SHOW_AFTER ) shown = true;
		if ( shown && idleFor >= HIDE_AFTER ) shown = false;

		el.hidden = ! shown || inXR;
		vr.visible = shown && inXR;
		if ( vr.visible ) ring.rotation.z -= dt * 5;

	}

	return {
		update,
		// Something has loaded and nothing has for a moment.
		get settled() {

			return everBusy && idleFor >= HIDE_AFTER;

		},
	};

}
