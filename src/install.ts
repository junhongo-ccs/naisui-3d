// On a phone in the browser, offer to add the viewer to the home screen: opened from there it
// runs full screen and sideways (public/manifest.webmanifest), so the 3D view gets the whole
// screen. Android's Chrome can install on a tap; iPhone's Safari can't be asked from a page, so
// the button shows where to do it instead. Hidden once installed, on PCs and headsets, and after
// the user closes it.

type InstallPrompt = Event & { prompt: () => Promise<void>, userChoice: Promise<unknown> };

const DISMISSED = 'naisui-3d:install-dismissed';

export function offerInstall() {

	const box = document.querySelector<HTMLElement>( '#install' )!;
	const go = document.querySelector<HTMLButtonElement>( '#install-go' )!;
	const iosHelp = document.querySelector<HTMLElement>( '#install-ios' )!;

	const installed = matchMedia( '(display-mode: standalone), (display-mode: fullscreen)' ).matches
		|| ( navigator as Navigator & { standalone?: boolean } ).standalone === true;
	const phone = matchMedia( '(pointer: coarse)' ).matches && Math.min( screen.width, screen.height ) < 600;
	if ( installed || ! phone || localStorage.getItem( DISMISSED ) ) return;

	let prompt: InstallPrompt | null = null;
	const ios = /iPhone|iPod/.test( navigator.userAgent );

	window.addEventListener( 'beforeinstallprompt', e => {

		e.preventDefault();
		prompt = e as InstallPrompt;
		box.hidden = false;

	} );
	window.addEventListener( 'appinstalled', () => ( box.hidden = true ) );
	if ( ios ) box.hidden = false;

	go.addEventListener( 'click', () => {

		if ( prompt ) {

			prompt.prompt();
			prompt.userChoice.finally( () => ( box.hidden = true ) );
			prompt = null;

		} else {

			iosHelp.hidden = ! iosHelp.hidden;

		}

	} );

	document.querySelector( '#install-close' )!.addEventListener( 'click', () => {

		box.hidden = true;
		localStorage.setItem( DISMISSED, '1' );

	} );

}
