import * as THREE from 'three';

// A board that shows errors and live VR state, so problems on the headset can be read off it
// without remote devtools. Errors are collected from page load on; the board is drawn only while
// it is shown.
export function createDebugBoard() {

	const MAX_ERRORS = 6;
	const WIDTH = 0.32; // m
	const PAD = 28, LINE = 38;

	const errors: { time: string, text: string, count: number }[] = [];
	let status: string[] = [];
	let dirty = true;
	let onError = () => {};

	function error( text: string ) {

		text = text.replace( /\s+/g, ' ' ).slice( 0, 240 );
		const same = errors.find( e => e.text === text );
		if ( same ) {

			same.count ++;

		} else {

			errors.push( { time: new Date().toTimeString().slice( 0, 8 ), text, count: 1 } );
			if ( errors.length > MAX_ERRORS ) errors.shift();

		}

		dirty = true;
		onError();

	}

	window.addEventListener( 'error', e => error( `${ e.message }（${ e.filename?.split( '/' ).pop() }:${ e.lineno }）` ) );
	window.addEventListener( 'unhandledrejection', e => error( `Promise: ${ e.reason?.message ?? e.reason }` ) );
	const consoleError = console.error.bind( console );
	console.error = ( ...args: unknown[] ) => {

		error( args.map( a => ( a instanceof Error ? a.message : String( a ) ) ).join( ' ' ) );
		consoleError( ...args );

	};

	const canvas = document.createElement( 'canvas' );
	canvas.width = 1200;
	canvas.height = 1150;
	const ctx = canvas.getContext( '2d' )!;
	const texture = new THREE.CanvasTexture( canvas );
	texture.colorSpace = THREE.SRGBColorSpace;
	const mesh = new THREE.Mesh(
		new THREE.PlaneGeometry( WIDTH, WIDTH * canvas.height / canvas.width ),
		new THREE.MeshBasicMaterial( { map: texture, transparent: true, depthTest: false } ),
	);
	mesh.renderOrder = 1000;

	// Break text into lines that fit the board.
	function wrap( text: string, width: number ): string[] {

		const lines: string[] = [];
		let line = '';
		for ( const ch of text ) {

			if ( ctx.measureText( line + ch ).width > width ) {

				lines.push( line );
				line = '';

			}

			line += ch;

		}

		if ( line ) lines.push( line );
		return lines;

	}

	function draw() {

		dirty = false;
		ctx.clearRect( 0, 0, canvas.width, canvas.height );
		ctx.fillStyle = 'rgba(12, 16, 22, 0.92)';
		ctx.beginPath();
		ctx.roundRect( 0, 0, canvas.width, canvas.height, 28 );
		ctx.fill();
		ctx.textBaseline = 'top';
		const width = canvas.width - PAD * 2;
		let y = PAD;
		const put = ( text: string, color: string ) => {

			ctx.fillStyle = color;
			for ( const l of wrap( text, width ) ) {

				if ( y + LINE > canvas.height - PAD ) return;
				ctx.fillText( l, PAD, y );
				y += LINE;

			}

		};

		ctx.font = 'bold 30px system-ui, sans-serif';
		put( '診断（X で閉じる）', '#9fd3ff' );
		ctx.font = '26px system-ui, sans-serif';
		put( 'スクリーンショット: 右手の Meta ボタン（丸く平らなボタン）を押したまま、右トリガーを引く。写真はヘッドセットの「ファイル」アプリか、スマホの Meta Horizon アプリで見られる', '#9fb3c8' );
		y += LINE / 2;
		ctx.font = '28px ui-monospace, monospace';
		status.forEach( s => put( s, '#ffffff' ) );
		y += LINE / 2;
		ctx.font = 'bold 30px system-ui, sans-serif';
		put( errors.length ? 'エラー' : 'エラー: なし', errors.length ? '#ff8a80' : '#9fb3c8' );
		ctx.font = '28px ui-monospace, monospace';
		for ( const e of errors.slice().reverse() ) put( `${ e.time } ${ e.count > 1 ? `×${ e.count } ` : '' }${ e.text }`, '#ffcdd2' );
		texture.needsUpdate = true;

	}

	return {
		mesh,
		error,
		setStatus( lines: string[] ) {

			status = lines;
			dirty = true;

		},
		// Redraw if anything changed and the board is in view.
		update() {

			if ( dirty && mesh.visible ) draw();

		},
		set onError( fn: () => void ) {

			onError = fn;

		},
	};

}
