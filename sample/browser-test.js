/*
	Portable Image Png

	Copyright (c) 2024 Cédric Ronvel

	The MIT License (MIT)

	Permission is hereby granted, free of charge, to any person obtaining a copy
	of this software and associated documentation files (the "Software"), to deal
	in the Software without restriction, including without limitation the rights
	to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
	copies of the Software, and to permit persons to whom the Software is
	furnished to do so, subject to the following conditions:

	The above copyright notice and this permission notice shall be included in all
	copies or substantial portions of the Software.

	THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
	IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
	FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
	AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
	LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
	OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
	SOFTWARE.
*/

"use strict" ;



const Png = PortableImagePng ;
const PortableImage = Png.PortableImage ;



async function testIndexed() {
	var $canvas = document.getElementById( 'canvas' ) ;
	var ctx = $canvas.getContext( '2d' ) ;

	var portableImage = await Png.loadImage( 'tiny-indexed.png' , { crc32: true } ) ;
	console.log( portableImage ) ;

	var imageDataParams = { scaleX: 20 , scaleY: 20 } ;
	var imageData = portableImage.createImageData( imageDataParams ) ;
	ctx.putImageData( imageData , 0 , 0 ) ;

	var colorRotationIndex = 0 ,
		colorRotation = [
			[255,0,0],
			[255,127,0],
			[255,255,0],
			[127,255,0],
			[0,255,0],
			[0,255,127],
			[0,255,255],
			[0,127,255],
			[0,0,255],
			[127,0,255],
			[255,0,255],
			[255,0,127],
			'#f00',
			'#ff0000',
			'#ff0000e0',
			'#ff0000c0',
			'#ff0000a0',
			'#ff000080',
			'#ff000060',
			'#ff000040',
			'#ff000020',
		] ;

	setInterval( async () => {
		let imageBitmap = await createImageBitmap( imageData ) ;

		colorRotationIndex = ( colorRotationIndex + 1 ) % colorRotation.length ;
		portableImage.setPaletteColor( 2 , colorRotation[ colorRotationIndex ] ) ;
		portableImage.updateImageData( imageData , imageDataParams ) ;
		ctx.putImageData( imageData , 0 , 0 ) ;
	} , 100 ) ;

	// Trigger a download
	//setTimeout( () => pixPal.downloadPng( 'my.png' ) , 1000 ) ;
}



async function testTrueColor() {
	var filename , imageDataParams ,
		$canvas = document.getElementById( 'canvas' ) ,
		ctx = $canvas.getContext( '2d' ) ;

	//filename = 'tiny-rgba.png' ;
	filename = 'tiny-rgba-2.png' ;
	//filename = 'tiny-rgb.png' ;
	//filename = 'tiny-indexed.png' ;
	//filename = 'tiny-grayscale.png' ;
	//filename = 'tiny-grayscale-alpha.png' ;
	//filename = 'spectrum-and-alpha.png' ;
	var portableImage = await Png.loadImage( filename , { crc32: true } ) ;
	console.log( portableImage ) ;

	//ctx.fillStyle = "green"; ctx.fillRect(0, 0, 100, 100);

	//imageDataParams = {} ;
	imageDataParams = {
		scaleX: 20 ,
		scaleY: 20 ,
		/*
		mapping: new PortableImage.MatrixChannelMapping(
			[
				0 , 0 , 1 , 0 , 0 ,
				0 , 1 , 0 , 0 , 0 ,
				1 , 0 , 0 , 0 , 0 ,
				0 , 0 , 0 , -1 , 255
			] ,
			4
		)
		//*/
	} ;
	var imageData = portableImage.createImageData( imageDataParams ) ;
	ctx.putImageData( imageData , 0 , 0 ) ;
}



async function testCompositing() {
	var filename , imageDataParams , overlayFilename , overlayImageDataParams ,
		$canvas = document.getElementById( 'canvas' ) ,
		ctx = $canvas.getContext( '2d' ) ;

	//filename = 'tiny-rgba.png' ;
	//filename = 'tiny-rgba-2.png' ;
	//filename = 'tiny-rgb.png' ;
	//filename = 'tiny-indexed.png' ;
	//filename = 'tiny-grayscale.png' ;
	//filename = 'tiny-grayscale-alpha.png' ;
	//filename = 'spectrum-and-alpha.png' ;
	filename = 'heart.png' ;
	var portableImage = await Png.loadImage( filename , { crc32: true } ) ;

	//overlayFilename = 'heart.png' ;
	overlayFilename = 'tiny-rgba-2.png' ;
	var overlayPortableImage = await Png.loadImage( overlayFilename , { crc32: true } ) ;

	//ctx.fillStyle = "green"; ctx.fillRect(0, 0, 100, 100);

	//imageDataParams = {} ;
	imageDataParams = {
		scaleX: 20 ,
		scaleY: 20
	} ;
	var imageData = portableImage.createImageData( imageDataParams ) ;

	overlayImageDataParams = {
		scaleX: 20 , scaleY: 20 ,
		//scaleX: 10 , scaleY: 10 ,
		//x: 25 , y: 25 ,
		compositing: PortableImage.compositing.normal ,
		//compositing: PortableImage.compositing.overMask ,
		//compositing: PortableImage.compositing.in ,
		//compositing: PortableImage.compositing.out ,
		//compositing: PortableImage.compositing.atop ,
		//compositing: PortableImage.compositing.xor ,
		//compositing: PortableImage.compositing.multiply ,
		//compositing: PortableImage.compositing.screen ,
		//compositing: PortableImage.compositing.overlay ,
	} ;
	overlayPortableImage.updateImageData( imageData , overlayImageDataParams ) ;

	ctx.putImageData( imageData , 0 , 0 ) ;
}


// Like jQuery's $(document).ready()
const ready = callback => {
    document.addEventListener( 'DOMContentLoaded' , function internalCallback() {
        document.removeEventListener( 'DOMContentLoaded' , internalCallback , false ) ;
        callback() ;
    } , false ) ;
} ;



//ready( testIndexed ) ;
//ready( testTrueColor ) ;
ready( testCompositing ) ;

