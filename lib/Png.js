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



const SequentialReadBuffer = require( 'stream-kit/lib/SequentialReadBuffer.js' ) ;
const SequentialWriteBuffer = require( 'stream-kit/lib/SequentialWriteBuffer.js' ) ;
const crc32 = require( 'crc-32' ) ;


// Includes depending on the environment
var PortableImage = null ;
var DecompressionStream = null ;
var CompressionStream = null ;
var loadFileAsync = null ;
var saveFileAsync = null ;
var download = null ;
var require_ = require ;	// this is used to fool Browserfify, so it doesn't try to include this in the build

if ( process.browser ) {
	PortableImage = window.PortableImage ;
	if ( ! PortableImage ) {
		try {
			PortableImage = require( 'portable-image' ) ;
		}
		catch ( error ) {}
	}

	DecompressionStream = window.DecompressionStream ;
	CompressionStream = window.CompressionStream ;
	loadFileAsync = async ( url ) => {
		var response = await fetch( url ) ;
		if ( ! response.ok ) {
			throw new Error( "Can't retrieve file: '" + url + "', " + response.status + " - " + response.statusText ) ;
		}
		var bytes = await response.bytes() ;
		var buffer = Buffer.from( bytes ) ;
		return buffer ;
	} ;
	saveFileAsync = () => { throw new Error( "Can't save from browser (use .download() instead)" ) ; } ;
	download = ( filename , buffer ) => {
		var anchor = window.document.createElement( 'a' ) ;
		anchor.href = window.URL.createObjectURL( new Blob( [ buffer ] , { type: 'application/octet-stream' } ) ) ;
		anchor.download = filename ;

		// Force a click to start downloading, even if the anchor is not even appended to the body
		anchor.click() ;
	} ;
}
else {
	( { DecompressionStream , CompressionStream } = require_( 'stream/web' ) ) ;

	try {
		PortableImage = require( 'portable-image' ) ;
	}
	catch ( error ) {}

	let fs = require_( 'fs' ) ;
	loadFileAsync = url => fs.promises.readFile( url ) ;
	saveFileAsync = ( url , data ) => fs.promises.writeFile( url , data ) ;
	download = () => { throw new Error( "Can't download from non-browser (use .saveFileAsync() instead)" ) ; } ;
}



function Png() {
	// IHDR
	this.width = - 1 ;
	this.height = - 1 ;
	this.bitDepth = - 1 ;
	this.colorType = - 1 ;
	this.compressionMethod = - 1 ;
	this.filterMethod = - 1 ;
	this.interlaceMethod = - 1 ;

	// PLTE (and tRNS for indexed mode)
	this.palette = [] ;

	// tRNS
	this.transparencyColorKey = null ;	// transperancy color, also known as color-key

	// bKGD
	this.backgroundColor = null ;
	this.backgroundColorIndex = - 1 ;

	// IDAT
	this.idatBuffers = [] ;

	// IEND
	this.iendReceived = false ;

	// Decoder data
	//this.readableBuffer = null ;
	this.bitsPerPixel = - 1 ;
	this.decodedBytesPerPixel = - 1 ;

	// Encoder data
	//this.writableBuffer = null ;

	// Final
	this.pixelBuffer = null ;
}

module.exports = Png ;

Png.PortableImage = PortableImage ;



Png.createEncoder = ( params = {} ) => {
	var png = new Png() ;

	png.width = + params.width || 0 ;
	png.height = + params.height || 0 ;
	png.bitDepth = + params.bitDepth || 0 ;
	png.colorType = params.colorType ?? Png.COLOR_TYPE_INDEXED ;

	png.compressionMethod = 0 ;
	png.filterMethod = 0 ;
	png.interlaceMethod = 0 ;	// unsupported

	if ( Array.isArray( params.palette ) ) { png.palette = params.palette ; }

	if ( params.pixelBuffer && ( params.pixelBuffer instanceof Buffer ) ) {
		png.pixelBuffer = params.pixelBuffer ;
	}

	if ( ! png.bitDepth ) {
		if ( png.colorType === Png.COLOR_TYPE_INDEXED ) {
			let colors = png.palette.length ;
			png.bitDepth =
				colors <= 2 ? 1 :
				colors <= 4 ? 2 :
				colors <= 16 ? 4 :
				8 ;
		}
		else {
			png.bitDepth = 8 ;
		}
	}

	png.computeBitsPerPixel() ;

	return png ;
} ;



// PNG constants

Png.COLOR_TYPE_GRAYSCALE = 0 ;
Png.COLOR_TYPE_RGB = 2 ;
Png.COLOR_TYPE_INDEXED = 3 ;
Png.COLOR_TYPE_GRAYSCALE_ALPHA = 4 ;
Png.COLOR_TYPE_RGBA = 6 ;



// Chunk/Buffer constants

const CHUNK_META_SIZE = 12 ;
// A PNG file always starts with this bytes
const PNG_MAGIC_NUMBERS = [ 0x89 , 0x50 , 0x4E , 0x47 , 0x0D , 0x0A , 0x1A , 0x0A ] ;
const PNG_MAGIC_NUMBERS_BUFFER = Buffer.from( PNG_MAGIC_NUMBERS ) ;
const IEND_CHUNK = [	// Instead of triggering the whole chunk machinery, just put this pre-computed IEND chunk
	0x00 , 0x00 , 0x00 , 0x00 ,		// Zero-length
	0x49 , 0x45 , 0x4e , 0x44 ,		// IEND
	0xae , 0x42 , 0x60 , 0x82		// CRC-32 of IEND
] ;
const IEND_CHUNK_BUFFER = Buffer.from( IEND_CHUNK ) ;



Png.load = async function( url , options = {} ) {
	var buffer = await loadFileAsync( url ) ;
	return Png.decode( buffer , options ) ;
} ;

Png.loadImage = async function( url , options = {} ) {
	var buffer = await loadFileAsync( url ) ;
	return Png.decodeImage( buffer , options ) ;
} ;



Png.decode = async function( buffer , options = {} ) {
	var png = new Png() ;
	await png.decode( buffer , options ) ;
	return png ;
} ;

Png.decodeImage = function( buffer , options = {} ) {
	var png = new Png() ;
	return png.decodeImage( buffer , options ) ;
} ;



Png.prototype.toImage = function( ImageClass = PortableImage.Image ) {
	var params = {
		width: this.width ,
		height: this.height ,
		pixelBuffer: this.pixelBuffer
	} ;

	switch ( this.colorType ) {
		case Png.COLOR_TYPE_RGB :
			params.channels = ImageClass.ChannelDef.RGB ;
			break ;
		case Png.COLOR_TYPE_RGBA :
			params.channels = ImageClass.ChannelDef.RGBA ;
			break ;
		case Png.COLOR_TYPE_GRAYSCALE :
			params.channels = [ 'gray' ] ;
			break ;
		case Png.COLOR_TYPE_GRAYSCALE_ALPHA :
			params.channels = [ 'gray' , 'alpha' ] ;
			break ;
		case Png.COLOR_TYPE_INDEXED :
			params.indexed = true ;
			params.palette = this.palette ;
			params.channels = ImageClass.ChannelDef.RGBA ;
			break ;
	}

	return new ImageClass( params ) ;
} ;



// Sadly it should be async, because browser's Compression API works with streams
Png.prototype.decode = async function( buffer , options = {} ) {
	var readableBuffer = new SequentialReadBuffer( buffer ) ;

	// Magic numbers
	for ( let i = 0 ; i < PNG_MAGIC_NUMBERS.length ; i ++ ) {
		if ( PNG_MAGIC_NUMBERS[ i ] !== readableBuffer.readUInt8() ) {
			throw new Error( "Not a PNG, it doesn't start with PNG magic numbers" ) ;
		}
	}

	this.palette.length = 0 ;
	this.pixelBuffer = null ;

	// Chunk reading
	while ( ! readableBuffer.ended ) {
		if ( this.iendReceived ) {
			throw new Error( "Bad PNG, chunk after IEND" ) ;
		}

		let chunkSize = readableBuffer.readUInt32BE() ;
		let chunkType = readableBuffer.readUtf8( 4 ) ;
		//let chunkType = readableBuffer.readString( 4 , 'latin1' ) ;

		//console.log( "Found chunk: '" + chunkType + "' of size: " + chunkSize ) ;

		if ( chunkDecoders[ chunkType ] ) {
			let chunkBuffer = readableBuffer.readBuffer( chunkSize , true ) ;
			let chunkCrc32 = readableBuffer.readInt32BE() ;

			if ( options.crc32 ) {
				let chunkComputedCrc32 = crc32.buf( chunkBuffer , crc32.bstr( chunkType ) ) ;
				if ( chunkComputedCrc32 !== chunkCrc32 ) {
					throw new Error( "Bad CRC-32 for chunk '" + chunkType + "', expecting: " + chunkCrc32 + " but got: " + chunkComputedCrc32  ) ;
				}
				//else { console.log( "  CRC-32 match: '" + chunkCrc32 + "' = '" + chunkComputedCrc32 + "'" ) ; }
			}

			chunkDecoders[ chunkType ].call( this , new SequentialReadBuffer( chunkBuffer ) , options ) ;
		}
		else {
			// Skip the chunk and its CRC
			readableBuffer.skip( chunkSize + 4 ) ;
		}
	}

	if ( ! this.iendReceived ) {
		throw new Error( "Bad PNG, no IEND chunk received" ) ;
	}

	await this.generateImageData() ;
} ;



Png.prototype.decodeImage = async function( buffer , options = {} ) {
	await this.decode( buffer , options ) ;
	return this.toImage( options.Image ) ;
} ;



Png.prototype.save = async function( url , options = {} ) {
	var buffer = await this.encode( options ) ;
	await saveFileAsync( url , buffer ) ;
} ;



Png.saveImage = async function( url , image , options = {} ) {
	var png = Png.fromImage( image ) ;
	var buffer = await png.encode( options ) ;
	await saveFileAsync( url , buffer ) ;
} ;



Png.prototype.download = async function( filename , options = {} ) {
	var buffer = await this.encode( options ) ;
	await download( filename , buffer ) ;
} ;



Png.fromImage = function( image ) {
	var params = {
		width: image.width ,
		height: image.height ,
		pixelBuffer: image.pixelBuffer
	} ;

	if ( ! image.isRgb && ! image.isRgba && ! image.isGray && ! image.isGrayAlpha ) {
		throw new Error( "The image is not supported, RGB, RGBA, Gray, or Gray+Alpha channels are required" ) ;
	}

	if ( image.indexed ) {
		params.colorType = Png.COLOR_TYPE_INDEXED ;
		params.palette = image.palette ;
	}
	else if ( image.isRgba ) {
		params.colorType = Png.COLOR_TYPE_RGBA ;
	}
	else if ( image.isRgb ) {
		params.colorType = Png.COLOR_TYPE_RGB ;
	}
	else if ( image.isGrayAlpha ) {
		params.colorType = Png.COLOR_TYPE_GRAYSCALE_ALPHA ;
	}
	else if ( image.isGray ) {
		params.colorType = Png.COLOR_TYPE_GRAYSCALE ;
	}

	return Png.createEncoder( params ) ;
} ;



Png.prototype.encode = async function( options = {} ) {
	var chunks = [] ;

	// Add magic numbers
	chunks.push( PNG_MAGIC_NUMBERS_BUFFER ) ;

	// IHDR: image header
	await this.addChunk( chunks , 'IHDR' , options ) ;

	// PLTE: the palette for indexed PNG
	await this.addChunk( chunks , 'PLTE' , options ) ;

	// tRNS: the color indexes for transparency
	await this.addChunk( chunks , 'tRNS' , options ) ;

	// bKGD: the default background color
	await this.addChunk( chunks , 'bKGD' , options ) ;

	// IDAT: the image pixel data
	await this.addChunk( chunks , 'IDAT' , options ) ;

	// Finalize by sending the IEND chunk to end the file
	chunks.push( IEND_CHUNK_BUFFER ) ;

	//console.log( "Chunks:" , chunks ) ;
	return Buffer.concat( chunks ) ;
} ;



Png.prototype.addChunk = async function( chunks , chunkType , options ) {
	if ( ! chunkEncoders[ chunkType ] ) { return ; }

	var dataBuffer = await chunkEncoders[ chunkType ].call( this , options ) ;
	if ( ! dataBuffer ) { return ; }

	var chunkBuffer = this.generateChunkFromData( chunkType , dataBuffer ) ;
	chunks.push( chunkBuffer ) ;
} ;



Png.prototype.generateChunkFromData = function( chunkType , dataBuffer ) {
	// 4 bytes for the data length | 4 bytes type (ascii) | chunk data (variable length) | 4 bytes of CRC-32 (type + data)
	var chunkBuffer = Buffer.alloc( CHUNK_META_SIZE + dataBuffer.length ) ;

	chunkBuffer.writeInt32BE( dataBuffer.length ) ;
	chunkBuffer.write( chunkType , 4 , 4 , 'latin1' ) ;
	dataBuffer.copy( chunkBuffer , 8 ) ;

	// Add the CRC-32, the 2nd argument of crc32.buf() is the seed, it's like building a CRC
	// of a single buffer containing chunkType + dataBuffer.
	var chunkComputedCrc32 = crc32.buf( dataBuffer , crc32.bstr( chunkType ) ) ;
	chunkBuffer.writeInt32BE( chunkComputedCrc32 , chunkBuffer.length - 4 ) ;
	//console.log( "Generated chunk: '" + chunkType + "' of size: " + dataBuffer.length + " and CRC-32: " + chunkComputedCrc32 ) ;

	return chunkBuffer ;
} ;



const chunkDecoders = {} ;
const chunkEncoders = {} ;

chunkDecoders.IHDR = function( readableBuffer , options ) {
	this.width = readableBuffer.readUInt32BE() ;
	this.height = readableBuffer.readUInt32BE() ;
	this.bitDepth = readableBuffer.readUInt8() ;
	this.colorType = readableBuffer.readUInt8() ;
	this.compressionMethod = readableBuffer.readUInt8() ;
	this.filterMethod = readableBuffer.readUInt8() ;
	this.interlaceMethod = readableBuffer.readUInt8() ;

	this.computeBitsPerPixel() ;

	//console.log( "After IHDR:" , this ) ;
} ;



chunkEncoders.IHDR = function( options ) {
	let writableBuffer = new SequentialWriteBuffer( 13 ) ;

	writableBuffer.writeUInt32BE( this.width ) ;
	writableBuffer.writeUInt32BE( this.height ) ;
	writableBuffer.writeUInt8( this.bitDepth ) ;
	writableBuffer.writeUInt8( this.colorType ) ;
	writableBuffer.writeUInt8( this.compressionMethod ) ;
	writableBuffer.writeUInt8( this.filterMethod ) ;
	writableBuffer.writeUInt8( this.interlaceMethod ) ;

	return writableBuffer.getBuffer( true ) ;
} ;



chunkDecoders.PLTE = function( readableBuffer , options ) {
	if ( this.colorType !== Png.COLOR_TYPE_INDEXED ) {
		throw new Error( "Unsupported color type for PLTE: " + this.colorType ) ;
	}

	this.palette.length = 0 ;

	let index = 0 ;

	while ( ! readableBuffer.ended ) {
		this.palette[ index ++ ] = [
			readableBuffer.readUInt8() ,
			readableBuffer.readUInt8() ,
			readableBuffer.readUInt8() ,
			255
		] ;
	}

	//console.log( "PLTE:" , this.palette ) ;
} ;



chunkEncoders.PLTE = function( options ) {
	if ( this.colorType !== Png.COLOR_TYPE_INDEXED ) { return ; }
	//if ( ! this.palette.length ) { return ; }

	let writableBuffer = new SequentialWriteBuffer( this.palette.length * 3 ) ;

	for ( let index = 0 ; index < this.palette.length ; index ++ ) {
		let color = this.palette[ index ] ;
		writableBuffer.writeUInt8( color[ 0 ] ) ;
		writableBuffer.writeUInt8( color[ 1 ] ) ;
		writableBuffer.writeUInt8( color[ 2 ] ) ;
	}

	return writableBuffer.getBuffer( true ) ;
} ;



chunkDecoders.tRNS = function( readableBuffer , options ) {
	switch ( this.colorType ) {
		case Png.COLOR_TYPE_RGB :
		case Png.COLOR_TYPE_RGBA : {
			let r = Math.min( 255 , readableBuffer.readUInt16BE() << ( 8 - this.bitDepth ) ) ;
			let g = Math.min( 255 , readableBuffer.readUInt16BE() << ( 8 - this.bitDepth ) ) ;
			let b = Math.min( 255 , readableBuffer.readUInt16BE() << ( 8 - this.bitDepth ) ) ;
			this.transparencyColorKey = [ r , g , b ] ;
			//console.log( "tRNS:" , this.transparencyColorKey ) ;
			break ;
		}
		case Png.COLOR_TYPE_GRAYSCALE :
		case Png.COLOR_TYPE_GRAYSCALE_ALPHA : {
			let grayscale = Math.min( 255 , readableBuffer.readUInt16BE() << ( 8 - this.bitDepth ) ) ;
			this.transparencyColorKey = [ grayscale ] ;
			//console.log( "tRNS:" , this.transparencyColorKey ) ;
			break ;
		}
		case Png.COLOR_TYPE_INDEXED : {
			let index = 0 ;

			while ( ! readableBuffer.ended && index < this.palette.length ) {
				this.palette[ index ++ ][ 3 ] = readableBuffer.readUInt8() ;
			}

			//console.log( "tRNS:" , this.palette ) ;
			break ;
		}
	}
} ;



chunkEncoders.tRNS = function( options ) {
	switch ( this.colorType ) {
		case Png.COLOR_TYPE_RGBA :
		case Png.COLOR_TYPE_GRAYSCALE_ALPHA : {
			// If there is an alpha channel, no need to save a tRNS
			return ;
		}
		case Png.COLOR_TYPE_RGB : {
			if ( ! this.transparencyColorKey ) { return ; }
			let buffer = Buffer.allocUnsafe( 6 ) ;
			buffer.writeUInt16BE( this.transparencyColorKey[ 0 ] >> ( 8 - this.bitDepth ) , 0 ) ;
			buffer.writeUInt16BE( this.transparencyColorKey[ 1 ] >> ( 8 - this.bitDepth ) , 2 ) ;
			buffer.writeUInt16BE( this.transparencyColorKey[ 2 ] >> ( 8 - this.bitDepth ) , 4 ) ;
			return buffer ;
		}
		case Png.COLOR_TYPE_GRAYSCALE : {
			if ( ! this.transparencyColorKey ) { return ; }
			let buffer = Buffer.allocUnsafe( 2 ) ;
			buffer.writeUInt16BE( this.transparencyColorKey[ 0 ] >> ( 8 - this.bitDepth ) , 0 ) ;
			return buffer ;
		}
		case Png.COLOR_TYPE_INDEXED : {
			if ( ! this.palette.length ) { return ; }
			return Buffer.from( this.palette.map( color => color[ 3 ] ) ) ;
		}
	}
} ;



chunkDecoders.bKGD = function( readableBuffer , options ) {
	switch ( this.colorType ) {
		case Png.COLOR_TYPE_RGB :
		case Png.COLOR_TYPE_RGBA : {
			let r = Math.min( 255 , readableBuffer.readUInt16BE() << ( 8 - this.bitDepth ) ) ;
			let g = Math.min( 255 , readableBuffer.readUInt16BE() << ( 8 - this.bitDepth ) ) ;
			let b = Math.min( 255 , readableBuffer.readUInt16BE() << ( 8 - this.bitDepth ) ) ;
			this.backgroundColor = [ r , g , b ] ;
			//console.log( "bKGD:" , this.backgroundColor ) ;
			break ;
		}
		case Png.COLOR_TYPE_GRAYSCALE :
		case Png.COLOR_TYPE_GRAYSCALE_ALPHA : {
			let grayscale = Math.min( 255 , readableBuffer.readUInt16BE() << ( 8 - this.bitDepth ) ) ;
			this.backgroundColor = [ grayscale , grayscale , grayscale ] ;
			//console.log( "bKGD:" , this.backgroundColor ) ;
			break ;
		}
		case Png.COLOR_TYPE_INDEXED : {
			this.backgroundColorIndex = readableBuffer.readUInt8() ;
			//console.log( "bKGD:" , this.backgroundColorIndex ) ;
			break ;
		}
	}
} ;



chunkEncoders.bKGD = function( options ) {
	if ( this.colorType !== Png.COLOR_TYPE_INDEXED || this.backgroundColorIndex < 0 ) { return ; }

	let buffer = Buffer.allocUnsafe( 1 ) ;
	buffer.writeUInt8( this.backgroundColorIndex , 0 ) ;
	return buffer ;
} ;



chunkDecoders.IDAT = function( readableBuffer , options ) {
	this.idatBuffers.push( readableBuffer.buffer ) ;
	//console.log( "Raw IDAT:" , readableBuffer.buffer , readableBuffer.buffer.length ) ;
} ;



chunkEncoders.IDAT = async function( options ) {
	if ( ! this.pixelBuffer ) { return ; }

	//if ( this.colorType !== Png.COLOR_TYPE_INDEXED ) { throw new Error( "Unsupported color type for IDAT: " + this.colorType ) ; }

	if ( this.interlaceMethod ) {
		throw new Error( "Interlace methods are unsupported (IDAT): " + this.interlaceMethod ) ;
	}

	//console.log( "Creating IDAT with bits per pixel / bit depth: " + this.bitsPerPixel + " / " + this.bitDepth ) ;

	var pixelBufferLineByteLength = this.width * this.decodedBytesPerPixel ;
	var lineByteLength = 1 + Math.ceil( this.width * this.bitsPerPixel / 8 ) ;
	var writableBuffer = new SequentialWriteBuffer( this.palette.length * 3 ) ;

	// Prepare the PNG buffer, using only filter 0 and no Adam7, we just want it to work
	for ( let y = 0 ; y < this.height ; y ++ ) {
		// We don't care for filters ATM, it requires heuristic, it's boring to do...
		writableBuffer.writeUInt8( 0 ) ;

		if ( this.bitsPerPixel >= 8 ) {
			writableBuffer.writeBuffer( this.pixelBuffer , y * pixelBufferLineByteLength , ( y + 1 ) * pixelBufferLineByteLength ) ;
		}
		else {
			for ( let x = 0 ; x < this.width ; x ++ ) {
				writableBuffer.writeUBits( this.pixelBuffer[ y * pixelBufferLineByteLength + x ] , this.bitsPerPixel ) ;
			}
		}
	}

	var compressedBuffer = await deflate( writableBuffer.getBuffer( true ) ) ;
	//console.log( "Compressed IDAT:" , compressedBuffer , compressedBuffer.length ) ;

	return compressedBuffer ;
} ;



chunkDecoders.IEND = function() {
	this.iendReceived = true ;
	//console.log( "IEND" ) ;
} ;



chunkEncoders.IEND = function() {
	return Buffer.allocUnsafe( 0 ) ;
} ;



Png.prototype.generateImageData = async function() {
	if ( this.interlaceMethod ) {
		throw new Error( "Interlace methods are unsupported (IDAT): " + this.interlaceMethod ) ;
	}

	this.pixelBuffer = Buffer.allocUnsafe( this.width * this.height * this.decodedBytesPerPixel ) ;

	var compressedBuffer = Buffer.concat( this.idatBuffers ) ;
	var buffer = await inflate( compressedBuffer ) ;
	//console.log( "Decompressed IDAT:" , buffer , buffer.length ) ;

	var lineByteLength = 1 + Math.ceil( this.width * this.bitsPerPixel / 8 ) ;
	var expectedBufferLength = lineByteLength * this.height ;
	var pixelBufferLineByteLength = this.width * this.decodedBytesPerPixel ;

	if ( expectedBufferLength !== buffer.length ) {
		throw new Error( "Expecting a decompressed buffer of length of " + expectedBufferLength + " but got: " + buffer.length ) ;
	}

	//console.log( "lineByteLength:" , lineByteLength ) ;
	for ( let y = 0 ; y < this.height ; y ++ ) {
		this.decodeLineFilter( buffer , y * lineByteLength , ( y + 1 ) * lineByteLength , ( y - 1 ) * lineByteLength ) ;	// Note: negative number = no previous line
		this.extractLine( buffer , y * lineByteLength + 1 , lineByteLength - 1 , y * pixelBufferLineByteLength ) ;
	}

	//console.log( "pixelBuffer:" , this.pixelBuffer , this.pixelBuffer.length ) ;
} ;



Png.prototype.extractLine = function( buffer , start , byteLength , pixelBufferStart ) {
	if ( this.bitsPerPixel >= 8 ) {
		buffer.copy( this.pixelBuffer , pixelBufferStart , start , start + byteLength ) ;
	}
	else {
		let readableBuffer = new SequentialReadBuffer( buffer.slice( start , start + byteLength ) ) ;
		for ( let x = 0 ; x < this.width ; x ++ ) {
			this.pixelBuffer[ pixelBufferStart + x ] = readableBuffer.readUBits( this.bitsPerPixel ) ;
		}
	}
} ;



Png.prototype.decodeLineFilter = function( buffer , start , end , lastLineStart ) {
	var filterType = buffer[ start ] ;
	if ( filterType === 0 ) { return ; }	// filter 0 doesn't change anything
	//console.log( "Watch out! FilterType is not 0! Filter:" , filterType ) ;
	if ( ! filters[ filterType ] ) { throw new Error( "Unknown filter type: " + filterType ) ; }

	var bytesPerPixel = Math.ceil( this.bitsPerPixel / 8 ) ;

	for ( let i = 1 , imax = end - start ; i < imax ; i ++ ) {
		/*
			We use the same byte names than in the PNG spec (https://www.w3.org/TR/png-3/#9Filter-types):

			c b			c: previous byte of the same color channel of the line before		b: byte of the previous line
			a x			a: previous byte of the same color channel							x: current byte
		*/

		let x = buffer[ start + i ] ,
			a = i > bytesPerPixel ? buffer[ start + i - bytesPerPixel ] : 0 ,
			b = lastLineStart >= 0 ? buffer[ lastLineStart + i ] : 0 ,
			c = i > bytesPerPixel && lastLineStart >= 0 ? buffer[ lastLineStart + i - bytesPerPixel ] : 0 ;

		// We modify in-place, it is possible and desirable since a, b and c requires the reconstructed bytes
		buffer[ start + i ] = filters[ filterType ].decode( x , a , b , c ) ;
	}
} ;



/*
	Filters details here: https://www.w3.org/TR/png-3/#9Filter-types
	For encode(): x, a, b, c are the original byte value.
	For decode(): x is the filtered (encoded) byte value, while a, b, c are the reconstructed byte value.
*/
const filters = [] ;

filters[ 0 ] = {
	encode: ( x , a , b , c ) => x ,
	decode: ( x , a , b , c ) => x
} ;

filters[ 1 ] = {
	encode: ( x , a , b , c ) => ( 256 + x - a ) % 256 ,
	decode: ( x , a , b , c ) => ( x + a ) % 256
} ;

filters[ 2 ] = {
	encode: ( x , a , b , c ) => ( 256 + x - b ) % 256 ,
	decode: ( x , a , b , c ) => ( x + b ) % 256
} ;

filters[ 3 ] = {
	encode: ( x , a , b , c ) => ( 256 + x - Math.floor( ( a + b ) / 2 ) ) % 256 ,
	decode: ( x , a , b , c ) => ( x + Math.floor( ( a + b ) / 2 ) ) % 256
} ;

filters[ 4 ] = {
	encode: ( x , a , b , c ) => ( 256 + x - paethPredictor( a , b , c ) ) % 256 ,
	decode: ( x , a , b , c ) => ( x + paethPredictor( a , b , c ) ) % 256
} ;

// A no-brainer port of the pseudo-code for PaethPredictor directly from the PNG spec, see here: https://www.w3.org/TR/png-3/#9Filter-types
function paethPredictor( a , b , c ) {
	var pr ,
		p = a + b - c ,
		pa = Math.abs( p - a ) ,
		pb = Math.abs( p - b ) ,
		pc = Math.abs( p - c ) ;

	if ( pa <= pb && pa <= pc ) { pr = a ; }
	else if ( pb <= pc ) { pr = b ; }
	else { pr = c ; }

	return pr ;
}



Png.prototype.computeBitsPerPixel = function() {
	switch ( this.colorType ) {
		case Png.COLOR_TYPE_GRAYSCALE :
		case Png.COLOR_TYPE_INDEXED :
			this.bitsPerPixel = this.bitDepth ;
			break ;
		case Png.COLOR_TYPE_RGB :
			this.bitsPerPixel = this.bitDepth * 3 ;
			break ;
		case Png.COLOR_TYPE_GRAYSCALE_ALPHA :
			this.bitsPerPixel = this.bitDepth * 2 ;
			break ;
		case Png.COLOR_TYPE_RGBA :
			this.bitsPerPixel = this.bitDepth * 4 ;
			break ;
	}

	this.decodedBytesPerPixel = Math.ceil( this.bitsPerPixel / 8 ) ;
} ;



async function inflate( buffer ) {
	const decompressionStream = new DecompressionStream( 'deflate' ) ;
	const blob = new Blob( [ buffer ] ) ;
	const stream = blob.stream().pipeThrough( decompressionStream ) ;
	//console.log( "Blob bytes:" , await blob.arrayBuffer() ) ;

	const chunks = [] ;
	for await ( let chunk of stream ) { chunks.push( chunk ) ; }

	// Buffer.concat() also accepts Uint8Array
	return Buffer.concat( chunks ) ;
}



async function deflate( buffer ) {
	const compressionStream = new CompressionStream( 'deflate' ) ;
	const blob = new Blob( [ buffer ] ) ;
	const stream = blob.stream().pipeThrough( compressionStream ) ;
	//console.log( "Blob bytes:" , await blob.arrayBuffer() ) ;

	const chunks = [] ;
	for await ( let chunk of stream ) { chunks.push( chunk ) ; }

	// Buffer.concat() also accepts Uint8Array
	return Buffer.concat( chunks ) ;
}

