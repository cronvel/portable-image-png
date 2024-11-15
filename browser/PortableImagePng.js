(function(f){if(typeof exports==="object"&&typeof module!=="undefined"){module.exports=f()}else if(typeof define==="function"&&define.amd){define([],f)}else{var g;if(typeof window!=="undefined"){g=window}else if(typeof global!=="undefined"){g=global}else if(typeof self!=="undefined"){g=self}else{g=this}g.PortableImagePng = f()}})(function(){var define,module,exports;return (function(){function r(e,n,t){function o(i,f){if(!n[i]){if(!e[i]){var c="function"==typeof require&&require;if(!f&&c)return c(i,!0);if(u)return u(i,!0);var a=new Error("Cannot find module '"+i+"'");throw a.code="MODULE_NOT_FOUND",a}var p=n[i]={exports:{}};e[i][0].call(p.exports,function(r){var n=e[i][1][r];return o(n||r)},p,p.exports,r,e,n,t)}return n[i].exports}for(var u="function"==typeof require&&require,i=0;i<t.length;i++)o(t[i]);return o}return r})()({1:[function(require,module,exports){
(function (process,Buffer){(function (){
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



Png.prototype.toImage = function( PortableImageClass = PortableImage ) {
	var params = {
		width: this.width ,
		height: this.height ,
		pixelBuffer: this.pixelBuffer
	} ;

	switch ( this.colorType ) {
		case Png.COLOR_TYPE_RGB :
			params.channels = PortableImageClass.RGB ;
			break ;
		case Png.COLOR_TYPE_RGBA :
			params.channels = PortableImageClass.RGBA ;
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
			params.channels = PortableImageClass.RGBA ;
			break ;
	}

	return new PortableImageClass( params ) ;
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
	return this.toImage( options.PortableImage ) ;
} ;



Png.prototype.save = async function( url , options = {} ) {
	var buffer = await this.encode( options ) ;
	await saveFileAsync( url , buffer ) ;
} ;



Png.saveImage = async function( url , portableImage , options = {} ) {
	var png = Png.fromImage( portableImage ) ;
	var buffer = await png.encode( options ) ;
	await saveFileAsync( url , buffer ) ;
} ;



Png.prototype.download = async function( filename , options = {} ) {
	var buffer = await this.encode( options ) ;
	await download( filename , buffer ) ;
} ;



Png.fromImage = function( portableImage ) {
	var params = {
		width: portableImage.width ,
		height: portableImage.height ,
		pixelBuffer: portableImage.pixelBuffer
	} ;

	if ( ! portableImage.isRgb && ! portableImage.isRgba && ! portableImage.isGray && ! portableImage.isGrayAlpha ) {
		throw new Error( "The image is not supported, RGB, RGBA, Gray, or Gray+Alpha channels are required" ) ;
	}

	if ( portableImage.indexed ) {
		params.colorType = Png.COLOR_TYPE_INDEXED ;
		params.palette = portableImage.palette ;
	}
	else if ( portableImage.isRgba ) {
		params.colorType = Png.COLOR_TYPE_RGBA ;
	}
	else if ( portableImage.isRgb ) {
		params.colorType = Png.COLOR_TYPE_RGB ;
	}
	else if ( portableImage.isGrayAlpha ) {
		params.colorType = Png.COLOR_TYPE_GRAYSCALE_ALPHA ;
	}
	else if ( portableImage.isGray ) {
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


}).call(this)}).call(this,require('_process'),require("buffer").Buffer)
},{"_process":11,"buffer":9,"crc-32":2,"portable-image":4,"stream-kit/lib/SequentialReadBuffer.js":6,"stream-kit/lib/SequentialWriteBuffer.js":7}],2:[function(require,module,exports){
/*! crc32.js (C) 2014-present SheetJS -- http://sheetjs.com */
/* vim: set ts=2: */
/*exported CRC32 */
var CRC32;
(function (factory) {
	/*jshint ignore:start */
	/*eslint-disable */
	if(typeof DO_NOT_EXPORT_CRC === 'undefined') {
		if('object' === typeof exports) {
			factory(exports);
		} else if ('function' === typeof define && define.amd) {
			define(function () {
				var module = {};
				factory(module);
				return module;
			});
		} else {
			factory(CRC32 = {});
		}
	} else {
		factory(CRC32 = {});
	}
	/*eslint-enable */
	/*jshint ignore:end */
}(function(CRC32) {
CRC32.version = '1.2.2';
/*global Int32Array */
function signed_crc_table() {
	var c = 0, table = new Array(256);

	for(var n =0; n != 256; ++n){
		c = n;
		c = ((c&1) ? (-306674912 ^ (c >>> 1)) : (c >>> 1));
		c = ((c&1) ? (-306674912 ^ (c >>> 1)) : (c >>> 1));
		c = ((c&1) ? (-306674912 ^ (c >>> 1)) : (c >>> 1));
		c = ((c&1) ? (-306674912 ^ (c >>> 1)) : (c >>> 1));
		c = ((c&1) ? (-306674912 ^ (c >>> 1)) : (c >>> 1));
		c = ((c&1) ? (-306674912 ^ (c >>> 1)) : (c >>> 1));
		c = ((c&1) ? (-306674912 ^ (c >>> 1)) : (c >>> 1));
		c = ((c&1) ? (-306674912 ^ (c >>> 1)) : (c >>> 1));
		table[n] = c;
	}

	return typeof Int32Array !== 'undefined' ? new Int32Array(table) : table;
}

var T0 = signed_crc_table();
function slice_by_16_tables(T) {
	var c = 0, v = 0, n = 0, table = typeof Int32Array !== 'undefined' ? new Int32Array(4096) : new Array(4096) ;

	for(n = 0; n != 256; ++n) table[n] = T[n];
	for(n = 0; n != 256; ++n) {
		v = T[n];
		for(c = 256 + n; c < 4096; c += 256) v = table[c] = (v >>> 8) ^ T[v & 0xFF];
	}
	var out = [];
	for(n = 1; n != 16; ++n) out[n - 1] = typeof Int32Array !== 'undefined' ? table.subarray(n * 256, n * 256 + 256) : table.slice(n * 256, n * 256 + 256);
	return out;
}
var TT = slice_by_16_tables(T0);
var T1 = TT[0],  T2 = TT[1],  T3 = TT[2],  T4 = TT[3],  T5 = TT[4];
var T6 = TT[5],  T7 = TT[6],  T8 = TT[7],  T9 = TT[8],  Ta = TT[9];
var Tb = TT[10], Tc = TT[11], Td = TT[12], Te = TT[13], Tf = TT[14];
function crc32_bstr(bstr, seed) {
	var C = seed ^ -1;
	for(var i = 0, L = bstr.length; i < L;) C = (C>>>8) ^ T0[(C^bstr.charCodeAt(i++))&0xFF];
	return ~C;
}

function crc32_buf(B, seed) {
	var C = seed ^ -1, L = B.length - 15, i = 0;
	for(; i < L;) C =
		Tf[B[i++] ^ (C & 255)] ^
		Te[B[i++] ^ ((C >> 8) & 255)] ^
		Td[B[i++] ^ ((C >> 16) & 255)] ^
		Tc[B[i++] ^ (C >>> 24)] ^
		Tb[B[i++]] ^ Ta[B[i++]] ^ T9[B[i++]] ^ T8[B[i++]] ^
		T7[B[i++]] ^ T6[B[i++]] ^ T5[B[i++]] ^ T4[B[i++]] ^
		T3[B[i++]] ^ T2[B[i++]] ^ T1[B[i++]] ^ T0[B[i++]];
	L += 15;
	while(i < L) C = (C>>>8) ^ T0[(C^B[i++])&0xFF];
	return ~C;
}

function crc32_str(str, seed) {
	var C = seed ^ -1;
	for(var i = 0, L = str.length, c = 0, d = 0; i < L;) {
		c = str.charCodeAt(i++);
		if(c < 0x80) {
			C = (C>>>8) ^ T0[(C^c)&0xFF];
		} else if(c < 0x800) {
			C = (C>>>8) ^ T0[(C ^ (192|((c>>6)&31)))&0xFF];
			C = (C>>>8) ^ T0[(C ^ (128|(c&63)))&0xFF];
		} else if(c >= 0xD800 && c < 0xE000) {
			c = (c&1023)+64; d = str.charCodeAt(i++)&1023;
			C = (C>>>8) ^ T0[(C ^ (240|((c>>8)&7)))&0xFF];
			C = (C>>>8) ^ T0[(C ^ (128|((c>>2)&63)))&0xFF];
			C = (C>>>8) ^ T0[(C ^ (128|((d>>6)&15)|((c&3)<<4)))&0xFF];
			C = (C>>>8) ^ T0[(C ^ (128|(d&63)))&0xFF];
		} else {
			C = (C>>>8) ^ T0[(C ^ (224|((c>>12)&15)))&0xFF];
			C = (C>>>8) ^ T0[(C ^ (128|((c>>6)&63)))&0xFF];
			C = (C>>>8) ^ T0[(C ^ (128|(c&63)))&0xFF];
		}
	}
	return ~C;
}
CRC32.table = T0;
// $FlowIgnore
CRC32.bstr = crc32_bstr;
// $FlowIgnore
CRC32.buf = crc32_buf;
// $FlowIgnore
CRC32.str = crc32_str;
}));

},{}],3:[function(require,module,exports){
/*
	Portable Image

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



// Base class
function Mapping( matrix , alphaChannelDst ) {
	this.matrix = matrix ;
	this.alphaChannelDst = alphaChannelDst ?? null ;
	this.composeChannelOrder = null ;

	if ( this.alphaChannelDst === null ) {
		this.compose = this.map ;
	}
	else {
		this.composeChannelOrder = [ this.alphaChannelDst ] ;
		for ( let i = 0 ; i < this.dstChannels ; i ++ ) {
			if ( i !== this.alphaChannelDst ) { this.composeChannelOrder.push( i ) ; }
		}
	}
}

Mapping.prototype.map = function() {} ;
Mapping.prototype.compose = function() {} ;
module.exports = Mapping ;



function clampUint8( value ) { return Math.max( 0 , Math.min( 255 , Math.round( value ) ) ) ; }
function normalizedToUint8( value ) { return Math.max( 0 , Math.min( 255 , Math.round( 255 * value ) ) ) ; }
function uint8ToNormalized( value ) { return Math.max( 0 , Math.min( 1 , value / 255 ) ) ; }

const NO_COMPOSITING = {
	alpha: ( alphaSrc /*, alphaDst */ ) => alphaSrc ,
	channel: ( alphaSrc , alphaDst , channelSrc /*, channelDst */ ) => channelSrc
} ;



/*
	Direct mapping of dst to src, each dst channel is copied from a src channel.
	Each entry is a src channel index.
*/
function DirectChannelMapping( matrix , alphaChannelDst ) {
	this.dstChannels = matrix.length ;
	Mapping.call( this , matrix , alphaChannelDst ) ;
}

DirectChannelMapping.prototype = Object.create( Mapping.prototype ) ;
DirectChannelMapping.prototype.constructor = DirectChannelMapping ;
Mapping.DirectChannelMapping = DirectChannelMapping ;

DirectChannelMapping.prototype.map = function( src , dst , iSrc , iDst , srcBuffer = src.buffer ) {
	for ( let cDst = 0 ; cDst < dst.channels ; cDst ++ ) {
		dst.buffer[ iDst + cDst ] = srcBuffer[ iSrc + this.matrix[ cDst ] ] ;
	}
} ;

DirectChannelMapping.prototype.compose = function( src , dst , iSrc , iDst , compositing = NO_COMPOSITING , srcBuffer = src.buffer ) {
	let alphaDst = dst.buffer[ iDst + this.alphaChannelDst ] / 255 ;
	let alphaSrc = 1 ;

	for ( let cDst of this.composeChannelOrder ) {
		if ( cDst === this.alphaChannelDst ) {
			alphaSrc = srcBuffer[ iSrc + this.matrix[ cDst ] ] / 255 ;
			dst.buffer[ iDst + cDst ] = normalizedToUint8( compositing.alpha( alphaSrc , alphaDst ) ) ;
		}
		else {
			dst.buffer[ iDst + cDst ] = normalizedToUint8( compositing.channel(
				alphaSrc ,
				alphaDst ,
				srcBuffer[ iSrc + this.matrix[ cDst ] ] / 255 ,
				dst.buffer[ iDst + cDst ] / 255
			) ) ;
		}
	}
} ;



/*
	Direct mapping of dst to src, each dst channel is copied from a src channel OR have a default value.
	There are 2 entries per dst channel, the first one is a src channel index, the second one is a default value.
	The default value is used unless its value is null.
*/
function DirectChannelMappingWithDefault( matrix , alphaChannelDst ) {
	this.dstChannels = Math.floor( matrix.length / 2 ) ;
	Mapping.call( this , matrix , alphaChannelDst ) ;
}

DirectChannelMappingWithDefault.prototype = Object.create( Mapping.prototype ) ;
DirectChannelMappingWithDefault.prototype.constructor = DirectChannelMappingWithDefault ;
Mapping.DirectChannelMappingWithDefault = DirectChannelMappingWithDefault ;

DirectChannelMappingWithDefault.prototype.map = function( src , dst , iSrc , iDst , srcBuffer = src.buffer ) {
	for ( let cDst = 0 ; cDst < dst.channels ; cDst ++ ) {
		dst.buffer[ iDst + cDst ] = this.matrix[ cDst * 2 + 1 ] ?? srcBuffer[ iSrc + this.matrix[ cDst * 2 ] ] ;
	}
} ;

DirectChannelMappingWithDefault.prototype.compose = function( src , dst , iSrc , iDst , compositing = NO_COMPOSITING , srcBuffer = src.buffer ) {
	let alphaDst = dst.buffer[ iDst + this.alphaChannelDst ] / 255 ;
	let alphaSrc = 1 ;

	for ( let cDst of this.composeChannelOrder ) {
		if ( cDst === this.alphaChannelDst ) {
			alphaSrc = ( this.matrix[ cDst * 2 + 1 ] ?? srcBuffer[ iSrc + this.matrix[ cDst * 2 ] ] ) / 255 ;
			dst.buffer[ iDst + cDst ] = normalizedToUint8( compositing.alpha( alphaSrc , alphaDst ) ) ;
		}
		else {
			dst.buffer[ iDst + cDst ] = normalizedToUint8( compositing.channel(
				alphaSrc ,
				alphaDst ,
				( this.matrix[ cDst * 2 + 1 ] ?? srcBuffer[ iSrc + this.matrix[ cDst * 2 ] ] ) / 255 ,
				dst.buffer[ iDst + cDst ] / 255
			) ) ;
		}
	}
} ;



/*
	Matrix mapping of the dst to src, each dst channel is composed by all src channels + one additional value.
	There are ( srcChannelsUsed + 1 ) entries per dst channel, the last one is the additionnal value.
*/
function MatrixChannelMapping( matrix , srcChannelsUsed , alphaChannelDst ) {
	this.dstChannels = Math.floor( matrix.length / ( srcChannelsUsed + 1 ) ) ;
	this.srcChannelsUsed = srcChannelsUsed ;
	Mapping.call( this , matrix , alphaChannelDst ) ;
}

MatrixChannelMapping.prototype = Object.create( Mapping.prototype ) ;
MatrixChannelMapping.prototype.constructor = MatrixChannelMapping ;
Mapping.MatrixChannelMapping = MatrixChannelMapping ;

MatrixChannelMapping.prototype.map = function( src , dst , iSrc , iDst , srcBuffer = src.buffer ) {
	let matrixIndex = 0 ;

	for ( let cDst = 0 ; cDst < dst.channels ; cDst ++ ) {
		let value = 0 ;

		for ( let cSrc = 0 ; cSrc < this.srcChannelsUsed ; cSrc ++ ) {
			value += srcBuffer[ iSrc + cSrc ] * this.matrix[ matrixIndex ++ ] ;
		}

		value += this.matrix[ matrixIndex ++ ] ;	// This is the additionnal value

		dst.buffer[ iDst + cDst ] = clampUint8( value ) ;
	}
} ;

MatrixChannelMapping.prototype.compose = function( src , dst , iSrc , iDst , compositing = NO_COMPOSITING , srcBuffer = src.buffer ) {
	let alphaDst = dst.buffer[ iDst + this.alphaChannelDst ] / 255 ;
	let alphaSrc = 1 ;

	for ( let cDst of this.composeChannelOrder ) {
		let matrixIndex = cDst * ( this.srcChannelsUsed + 1 ) ;
		let value = 0 ;

		for ( let cSrc = 0 ; cSrc < this.srcChannelsUsed ; cSrc ++ ) {
			value += srcBuffer[ iSrc + cSrc ] * this.matrix[ matrixIndex ++ ] ;
		}

		value += this.matrix[ matrixIndex ++ ] ;	// This is the additionnal value
		value = uint8ToNormalized( value ) ;

		if ( cDst === this.alphaChannelDst ) {
			// Always executed at the first loop iteration
			dst.buffer[ iDst + cDst ] = normalizedToUint8( compositing.alpha( value , alphaDst ) ) ;
		}
		else {
			dst.buffer[ iDst + cDst ] = normalizedToUint8( compositing.channel(
				alphaSrc ,
				alphaDst ,
				value ,
				dst.buffer[ iDst + cDst ] / 255
			) ) ;
		}
	}
} ;



/*
	Built-in channel mapping.
	Should come after prototype definition, because of *.prototype = Object.create(...)
*/

Mapping.RGBA_COMPATIBLE_TO_RGBA = new DirectChannelMapping( [ 0 , 1 , 2 , 3 ] , 3 ) ;

Mapping.RGB_COMPATIBLE_TO_RGBA = new DirectChannelMappingWithDefault(
	[
		0 , null ,
		1 , null ,
		2 , null ,
		null , 255
	] ,
	3
) ;

Mapping.GRAY_ALPHA_COMPATIBLE_TO_RGBA = new DirectChannelMapping( [ 0 , 0 , 0 , 1 ] , 3 ) ;

Mapping.GRAY_COMPATIBLE_TO_RGBA = new DirectChannelMappingWithDefault(
	[
		0 , null ,
		0 , null ,
		0 , null ,
		null , 255
	] ,
	3
) ;

Mapping.RGBA_COMPATIBLE_TO_GRAY_ALPHA = new MatrixChannelMapping(
	[
		1 / 3 , 1 / 3 , 1 / 3 , 0 , 0 ,
		0 , 0 , 0 , 1 , 0
	] ,
	4 ,
	1
) ;

Mapping.RGB_COMPATIBLE_TO_GRAY_ALPHA = new MatrixChannelMapping(
	[
		1 / 3 , 1 / 3 , 1 / 3 , 0 ,
		0 , 0 , 0 , 255
	] ,
	3 ,
	1
) ;


},{}],4:[function(require,module,exports){
(function (Buffer){(function (){
/*
	Portable Image

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



/*
	Params:
		width: image width in pixel
		height: image height in pixel
		channels: the channels, default to [ 'red' , 'green' , 'blue' , 'alpha' ] or PortableImage.RGBA
		indexed: (boolean) it uses a palette, up to 256 entries, each pixel is a 1-Byte index
		palette: (array of array of integers) force indexed a pass an array of array of channel value
		pixelBuffer: (Buffer or Uint8Array) the buffer containing all the pixel data
*/
function PortableImage( params = {} ) {
	this.width = params.width ;
	this.height = params.height ;
	this.channels = Array.isArray( params.channels ) ? params.channels : PortableImage.RGBA ;
	this.indexed = params.indexed || Array.isArray( params.palette ) ;
	this.bytesPerPixel = this.indexed ? 1 : this.channels.length ;
	this.palette = this.indexed ? [] : null ;
	this.pixelBuffer = null ;

	if ( params.pixelBuffer ) {
		if ( params.pixelBuffer instanceof Buffer ) {
			if ( params.pixelBuffer.length !== this.width * this.height * this.bytesPerPixel ) {
				throw new Error( "Provided pixel Buffer mismatch the expected size (should be exactly width * height * bytesPerPixel)" ) ;
			}

			this.pixelBuffer = params.pixelBuffer ;
		}
		else if ( params.pixelBuffer instanceof Uint8Array ) {
			if ( params.pixelBuffer.length !== this.width * this.height * this.bytesPerPixel ) {
				throw new Error( "Provided pixel Uint8Array buffer mismatch the expected size (should be exactly width * height * bytesPerPixel)" ) ;
			}

			this.pixelBuffer = Buffer.from( params.pixelBuffer ) ;
		}
		else {
			throw new Error( "Provided pixel buffer is not a Buffer or a Uint8Array" ) ;
		}
	}
	else {
		this.pixelBuffer = new Buffer( this.width * this.height * this.bytesPerPixel ) ;
	}

	if ( Array.isArray( params.palette ) ) {
		this.setPalette( params.palette ) ;
	}

	this.channelIndex = {} ;
	for ( let i = 0 ; i < this.channels.length ; i ++ ) {
		this.channelIndex[ this.channels[ i ] ] = i ;
	}

	this.isRgbCompatible = this.channels.length >= 3 && this.channels[ 0 ] === 'red' && this.channels[ 1 ] === 'green' && this.channels[ 2 ] === 'blue' ;
	this.isRgbaCompatible = this.channels.length >= 4 && this.isRgbCompatible && this.channels[ 3 ] === 'alpha' ;
	this.isRgb = this.isRgbCompatible && this.channels.length === 3 ;
	this.isRgba = this.isRgbaCompatible && this.channels.length === 4 ;

	this.isGrayCompatible = this.channels.length >= 1 && this.channels[ 0 ] === 'gray' ;
	this.isGrayAlphaCompatible = this.channels.length >= 2 && this.isGrayCompatible && this.channels[ 1 ] === 'alpha' ;
	this.isGray = this.isGrayCompatible && this.channels.length === 1 ;
	this.isGrayAlpha = this.isGrayAlphaCompatible && this.channels.length === 2 ;
}

module.exports = PortableImage ;



const Mapping = PortableImage.Mapping = require( './Mapping.js' ) ;
PortableImage.Mapping = Mapping ;
PortableImage.DirectChannelMapping = Mapping.DirectChannelMapping ;
PortableImage.DirectChannelMappingWithDefault = Mapping.DirectChannelMappingWithDefault ;
PortableImage.MatrixChannelMapping = Mapping.MatrixChannelMapping ;

PortableImage.compositing = require( './compositing.js' ) ;



PortableImage.RGB = [ 'red' , 'green' , 'blue' ] ;
PortableImage.RGBA = [ 'red' , 'green' , 'blue' , 'alpha' ] ;
PortableImage.GRAY = [ 'gray' ] ;
PortableImage.GRAY_ALPHA = [ 'gray' , 'alpha' ] ;



PortableImage.prototype.setPalette = function( palette ) {
	if ( ! this.indexed ) { throw new Error( "This is not an indexed image" ) ; }

	this.palette.length = 0 ;

	for ( let index = 0 ; index < palette.length ; index ++ ) {
		this.setPaletteEntry( index , palette[ index ] ) ;
	}
} ;



PortableImage.prototype.setPaletteEntry = function( index , entry ) {
	if ( this.isRgb || this.isRgba ) { return this.setPaletteColor( index , entry ) ; }

	if ( ! this.indexed ) { throw new Error( "This is not an indexed image" ) ; }
	if ( ! entry ) { return ; }

	var currentEntry = this.palette[ index ] ;
	if ( ! currentEntry ) { currentEntry = this.palette[ index ] = [] ; }

	if ( Array.isArray( entry ) ) {
		for ( let i = 0 ; i < this.channels.length ; i ++ ) {
			currentEntry[ i ] = entry[ i ] ?? 0 ;
		}
	}
	else if ( typeof entry === 'object' ) {
		for ( let i = 0 ; i < this.channels.length ; i ++ ) {
			currentEntry[ i ] = entry[ this.channels[ i ] ] ?? 0 ;
		}
	}
} ;



const LESSER_BYTE_MASK = 0xff ;

PortableImage.prototype.setPaletteColor = function( index , color ) {
	if ( ! this.indexed ) { throw new Error( "This is not an indexed image" ) ; }
	if ( ! color ) { return ; }

	var currentColor = this.palette[ index ] ;
	if ( ! currentColor ) { currentColor = this.palette[ index ] = [] ; }

	if ( Array.isArray( color ) ) {
		currentColor[ 0 ] = color[ 0 ] ?? 0 ;
		currentColor[ 1 ] = color[ 1 ] ?? 0 ;
		currentColor[ 2 ] = color[ 2 ] ?? 0 ;
		if ( this.isRgba ) { currentColor[ 3 ] = color[ 3 ] ?? 255 ; }
	}
	else if ( typeof color === 'object' ) {
		currentColor[ 0 ] = color.R ?? color.r ?? 0 ;
		currentColor[ 1 ] = color.G ?? color.g ?? 0 ;
		currentColor[ 2 ] = color.B ?? color.b ?? 0 ;
		if ( this.isRgba ) { currentColor[ 3 ] = color.A ?? color.a ?? 255 ; }
	}
	else if ( typeof color === 'string' && color[ 0 ] === '#' ) {
		color = color.slice( 1 ) ;
		if ( color.length === 3 ) {
			color = color[ 0 ] + color[ 0 ] + color[ 1 ] + color[ 1 ] + color[ 2 ] + color[ 2 ] ;
		}

		let code = Number.parseInt( color , 16 ) ;

		if ( color.length === 6 ) {
			currentColor[ 0 ] = ( code >> 16 ) & LESSER_BYTE_MASK ;
			currentColor[ 1 ] = ( code >> 8 ) & LESSER_BYTE_MASK ;
			currentColor[ 2 ] = code & LESSER_BYTE_MASK ;
			if ( this.isRgba ) { currentColor[ 3 ] = 255 ; }
		}
		else if ( color.length === 8 ) {
			currentColor[ 0 ] = ( code >> 24 ) & LESSER_BYTE_MASK ;
			currentColor[ 1 ] = ( code >> 16 ) & LESSER_BYTE_MASK ;
			currentColor[ 2 ] = ( code >> 8 ) & LESSER_BYTE_MASK ;
			if ( this.isRgba ) { currentColor[ 3 ] = code & LESSER_BYTE_MASK ; }
		}
	}
} ;



// Simple color matcher
PortableImage.prototype.getClosestPaletteIndex = ( channelValues ) => {
	var cMax = Math.min( this.channels.length , channelValues.length ) ,
		minDist = Infinity ,
		minIndex = 0 ;

	for ( let index = 0 ; index < this.palette.length ; index ++ ) {
		let dist = 0 ;

		for ( let c = 0 ; c < cMax ; c ++ ) {
			let delta = this.palette[ index ][ c ] - channelValues[ c ] ;
			dist += delta * delta ;

			if ( dist < minDist ) {
				minDist = dist ;
				minIndex = index ;
			}
		}
	}

	return minIndex ;
} ;



/*
	Copy to another PortableImage instance.
*/
PortableImage.prototype.copyTo = function( portableImage , mapping = null ) {
	let src = {
		buffer: this.pixelBuffer ,
		width: this.width ,
		height: this.height ,
		bytesPerPixel: this.bytesPerPixel ,
		x: 0 ,
		y: 0 ,
		endX: this.width ,
		endY: this.height
	} ;

	let dst = {
		buffer: portableImage.pixelBuffer ,
		width: portableImage.width ,
		height: portableImage.height ,
		bytesPerPixel: portableImage.bytesPerPixel ,
		x: 0 ,
		y: 0 ,
		endX: portableImage.width ,
		endY: portableImage.height ,

		scaleX: 1 ,
		scaleY: 1 ,
		mapping: mapping || this.getMappingTo( portableImage )
	} ;
	//console.log( "### Mapping: " , dst.mapping ) ;

	if ( this.indexed ) {
		src.palette = this.palette ;
		PortableImage.indexedBlit( src , dst ) ;
	}
	else {
		PortableImage.blit( src , dst ) ;
	}
} ;



/*
	Mapping is an array of twice the number of the channels, pairs of values :
	* the first value of the pair is the channel fixed value, it's null if the second of the pair should be used instead
	* the second value of the pair is the source channel index, it's null if the first of the pair should be used instead
*/

PortableImage.DEFAULT_CHANNEL_VALUES = {
	red: 0 ,
	green: 0 ,
	blue: 0 ,
	alpha: 255
} ;

// Create the mapping to another PortableImage
PortableImage.prototype.getMappingTo = function( toPortableImage , defaultChannelValues = PortableImage.DEFAULT_CHANNEL_VALUES ) {
	return this.getMappingToChannels( toPortableImage.channels , defaultChannelValues ) ;
} ;

PortableImage.prototype.getMappingToChannels = function( toChannels , defaultChannelValues = PortableImage.DEFAULT_CHANNEL_VALUES ) {
	var matrix = new Array( toChannels.length * 2 ) ;

	for ( let index = 0 ; index < toChannels.length ; index ++ ) {
		let channel = toChannels[ index ] ;

		if ( Object.hasOwn( this.channelIndex , channel ) ) {
			matrix[ index * 2 ] = this.channelIndex[ channel ] ;
			matrix[ index * 2 + 1 ] = null ;
		}
		else {
			matrix[ index * 2 ] = null ;
			matrix[ index * 2 + 1 ] = defaultChannelValues[ channel ] ?? 0 ;
		}
	}

	return new PortableImage.DirectChannelMappingWithDefault( matrix ) ;
} ;

PortableImage.getMapping = function( fromChannels , toChannels , defaultChannelValues = PortableImage.DEFAULT_CHANNEL_VALUES ) {
	var matrix = new Array( toChannels.length * 2 ) ;

	for ( let index = 0 ; index < toChannels.length ; index ++ ) {
		let channel = toChannels[ index ] ;
		let indexOf = fromChannels.indexOf( channel ) ;

		if ( indexOf >= 0 ) {
			matrix[ index * 2 ] = indexOf ;
			matrix[ index * 2 + 1 ] = null ;
		}
		else {
			matrix[ index * 2 ] = null ;
			matrix[ index * 2 + 1 ] = defaultChannelValues[ channel ] ?? 0 ;
		}
	}

	return new PortableImage.DirectChannelMappingWithDefault( matrix ) ;
} ;



PortableImage.prototype.createImageData = function( params = {} ) {
	var scaleX = params.scaleX ?? params.scale ?? 1 ,
		scaleY = params.scaleY ?? params.scale ?? 1 ;

	var imageData = new ImageData( this.width * scaleX , this.height * scaleY ) ;
	this.updateImageData( imageData , params ) ;
	return imageData ;
} ;



PortableImage.prototype.updateImageData = function( imageData , params = {} ) {
	var mapping = params.mapping ,
		scaleX = params.scaleX ?? params.scale ?? 1 ,
		scaleY = params.scaleY ?? params.scale ?? 1 ;

	if ( ! mapping ) {
		if ( imageData.width === this.width && imageData.height === this.height ) {
			if ( this.indexed ) {
				if ( this.isRgbaCompatible ) { return this.isoIndexedRgbaCompatibleToRgbaBlit( imageData.data ) ; }
				if ( this.isRgbCompatible ) { return this.isoIndexedRgbCompatibleToRgbaBlit( imageData.data ) ; }
			}
			else {
				if ( this.isRgbaCompatible ) { return this.isoRgbaCompatibleToRgbaBlit( imageData.data ) ; }
				if ( this.isRgbCompatible ) { return this.isoRgbCompatibleToRgbaBlit( imageData.data ) ; }
			}
		}

		if ( this.isRgbaCompatible ) { mapping = Mapping.RGBA_COMPATIBLE_TO_RGBA ; }
		else if ( this.isRgbCompatible ) { mapping = Mapping.RGB_COMPATIBLE_TO_RGBA ; }
		else if ( this.isGrayAlphaCompatible ) { mapping = Mapping.GRAY_ALPHA_COMPATIBLE_TO_RGBA ; }
		else if ( this.isGrayCompatible ) { mapping = Mapping.GRAY_COMPATIBLE_TO_RGBA ; }
		else { throw new Error( "Mapping required for image that are not RGB/RGBA/Grayscale/Grayscale+Alpha compatible" ) ; }
	}

	//console.warn( "Mapping:" , mapping ) ;

	let src = {
		buffer: this.pixelBuffer ,
		width: this.width ,
		height: this.height ,
		bytesPerPixel: this.bytesPerPixel ,
		x: params.x < 0 ? - params.x / scaleX : 0 ,
		y: params.y < 0 ? - params.y / scaleY : 0 ,
		endX: this.width ,
		endY: this.height ,
		channels: this.channels.length ,
		scaleX ,
		scaleY ,
		mapping ,
		compositing: params.compositing || null
	} ;

	let dst = {
		buffer: imageData.data ,
		width: imageData.width ,
		height: imageData.height ,
		bytesPerPixel: 4 ,
		x: params.x > 0 ? params.x : 0 ,
		y: params.y > 0 ? params.y : 0 ,
		endX: imageData.width ,
		endY: imageData.height ,
		channels: 4
	} ;

	if ( src.compositing ) {
		if ( this.indexed ) {
			src.palette = this.palette ;
			PortableImage.indexedCompositingBlit( src , dst ) ;
		}
		else {
			PortableImage.compositingBlit( src , dst ) ;
		}
	}
	else {
		if ( this.indexed ) {
			src.palette = this.palette ;
			PortableImage.indexedBlit( src , dst ) ;
		}
		else {
			PortableImage.blit( src , dst ) ;
		}
	}
} ;



/*
	Perform a regular blit, copying a rectangle are a the src to a rectangulare are of the dst.

	src, dst:
		* buffer: array-like
		* width,height: geometry stored in the array-like
		* bytesPerPixel
		* x,y: coordinate where to start copying (included)
		* endX,endY: coordinate where to stop copying (excluded)
	src only:
		* scaleX,scaleY: drawing scale (nearest)
		* mapping: an instance of Mapping, that maps the channels from src to dst
*/
PortableImage.blit = function( src , dst ) {
	//console.warn( ".blit() used" , src , dst ) ;
	var blitWidth = Math.min( dst.endX - dst.x , ( src.endX - src.x ) * src.scaleX ) ,
		blitHeight = Math.min( dst.endY - dst.y , ( src.endY - src.y ) * src.scaleY ) ,
		channels = Math.floor( src.mapping.length / 2 ) ;

	for ( let yOffset = 0 ; yOffset < blitHeight ; yOffset ++ ) {
		for ( let xOffset = 0 ; xOffset < blitWidth ; xOffset ++ ) {
			let iDst = ( ( dst.y + yOffset ) * dst.width + ( dst.x + xOffset ) ) * dst.bytesPerPixel ;
			let iSrc = ( Math.floor( src.y + yOffset / src.scaleY ) * src.width + Math.floor( src.x + xOffset / src.scaleX ) ) * src.bytesPerPixel ;
			src.mapping.map( src , dst , iSrc , iDst ) ;
		}
	}
} ;



/*
	Perform a blit, but the source pixel is an index, that will be substituted by the relevant source palette.

	Same arguments than .blit(), plus:

	src only:
		* palette: an array of array of values
*/
PortableImage.indexedBlit = function( src , dst ) {
	//console.warn( ".indexedBlit() used" , src , dst ) ;
	var blitWidth = Math.min( dst.endX - dst.x , ( src.endX - src.x ) * src.scaleX ) ,
		blitHeight = Math.min( dst.endY - dst.y , ( src.endY - src.y ) * src.scaleY ) ,
		channels = Math.floor( src.mapping.length / 2 ) ;

	for ( let yOffset = 0 ; yOffset < blitHeight ; yOffset ++ ) {
		for ( let xOffset = 0 ; xOffset < blitWidth ; xOffset ++ ) {
			let iDst = ( ( dst.y + yOffset ) * dst.width + ( dst.x + xOffset ) ) * dst.bytesPerPixel ;
			let iSrc = ( Math.floor( src.y + yOffset / src.scaleY ) * src.width + Math.floor( src.x + xOffset / src.scaleX ) ) * src.bytesPerPixel ;
			let channelValues = src.palette[ src.buffer[ iSrc ] ] ;
			src.mapping.map( src , dst , 0 , iDst , channelValues ) ;
		}
	}
} ;



/*
	Perform a blit, but with compositing (alpha-blending, etc).

	src only:
		* compositing: a compositing object, having a method "alpha" and "channel"
*/
PortableImage.compositingBlit = function( src , dst ) {
	//console.warn( ".compositingBlit() used" , src , dst ) ;
	var blitWidth = Math.min( dst.endX - dst.x , ( src.endX - src.x ) * src.scaleX ) ,
		blitHeight = Math.min( dst.endY - dst.y , ( src.endY - src.y ) * src.scaleY ) ,
		channels = Math.floor( src.mapping.length / 2 ) ;

	for ( let yOffset = 0 ; yOffset < blitHeight ; yOffset ++ ) {
		for ( let xOffset = 0 ; xOffset < blitWidth ; xOffset ++ ) {
			let iDst = ( ( dst.y + yOffset ) * dst.width + ( dst.x + xOffset ) ) * dst.bytesPerPixel ;
			let iSrc = ( Math.floor( src.y + yOffset / src.scaleY ) * src.width + Math.floor( src.x + xOffset / src.scaleX ) ) * src.bytesPerPixel ;
			src.mapping.compose( src , dst , iSrc , iDst , src.compositing ) ;
		}
	}
} ;



/*
	Perform a blit, but with compositing (alpha-blending, etc) + the source pixel is an index,
	that will be substituted by the relevant source palette.

	Same arguments than .blit(), plus:

	src only:
		* palette: an array of array of values
		* compositing: a compositing object, having a method "alpha" and "channel"
*/
PortableImage.indexedCompositingBlit = function( src , dst ) {
	console.warn( ".indexedCompositingBlit() used" , src , dst ) ;
	var blitWidth = Math.min( dst.endX - dst.x , ( src.endX - src.x ) * src.scaleX ) ,
		blitHeight = Math.min( dst.endY - dst.y , ( src.endY - src.y ) * src.scaleY ) ,
		channels = Math.floor( src.mapping.length / 2 ) ;

	for ( let yOffset = 0 ; yOffset < blitHeight ; yOffset ++ ) {
		for ( let xOffset = 0 ; xOffset < blitWidth ; xOffset ++ ) {
			let iDst = ( ( dst.y + yOffset ) * dst.width + ( dst.x + xOffset ) ) * dst.bytesPerPixel ;
			let iSrc = ( Math.floor( src.y + yOffset / src.scaleY ) * src.width + Math.floor( src.x + xOffset / src.scaleX ) ) * src.bytesPerPixel ;
			let channelValues = src.palette[ src.buffer[ iSrc ] ] ;
			src.mapping.compose( src , dst , 0 , iDst , src.compositing , channelValues ) ;
		}
	}
} ;



// Optimized Blit for RGB-compatible to RGBA
PortableImage.prototype.isoRgbCompatibleToRgbaBlit = function( dst ) {
	//console.warn( ".isoRgbCompatibleToRgbaBlit() used" , dst ) ;
	for ( let i = 0 , imax = this.width * this.height ; i < imax ; i ++ ) {
		let iSrc = i * this.bytesPerPixel ;
		let iDst = i * 4 ;

		dst[ iDst ] = this.pixelBuffer[ iSrc ] ;			// Red
		dst[ iDst + 1 ] = this.pixelBuffer[ iSrc + 1 ] ;	// Green
		dst[ iDst + 2 ] = this.pixelBuffer[ iSrc + 2 ] ;	// Blue
		dst[ iDst + 3 ] = 255 ;	// Alpha
	}
} ;



// Optimized Blit for RGBA-compatible to RGBA
PortableImage.prototype.isoRgbaCompatibleToRgbaBlit = function( dst ) {
	//console.warn( ".isoRgbaCompatibleToRgbaBlit() used" , dst , this ) ;
	for ( let i = 0 , imax = this.width * this.height ; i < imax ; i ++ ) {
		let iSrc = i * this.bytesPerPixel ;
		let iDst = i * 4 ;

		dst[ iDst ] = this.pixelBuffer[ iSrc ] ;			// Red
		dst[ iDst + 1 ] = this.pixelBuffer[ iSrc + 1 ] ;	// Green
		dst[ iDst + 2 ] = this.pixelBuffer[ iSrc + 2 ] ;	// Blue
		dst[ iDst + 3 ] = this.pixelBuffer[ iSrc + 3 ] ;	// Alpha
	}
} ;



// Optimized Blit for Indexed RGB-compatible to RGBA
PortableImage.prototype.isoIndexedRgbCompatibleToRgbaBlit = function( dst ) {
	//console.warn( ".isoIndexedRgbCompatibleToRgbaBlit() used" , dst ) ;
	for ( let i = 0 , imax = this.width * this.height ; i < imax ; i ++ ) {
		let iSrc = i * this.bytesPerPixel ;
		let iDst = i * 4 ;
		let paletteEntry = this.palette[ this.pixelBuffer[ iSrc ] ] ;

		dst[ iDst ] = paletteEntry[ 0 ] ;		// Red
		dst[ iDst + 1 ] = paletteEntry[ 1 ] ;	// Green
		dst[ iDst + 2 ] = paletteEntry[ 2 ] ;	// Blue
		dst[ iDst + 3 ] = 255 ;	// Alpha
	}
} ;



// Optimized Blit for Indexed RGBA-compatible to RGBA
PortableImage.prototype.isoIndexedRgbaCompatibleToRgbaBlit = function( dst ) {
	//console.warn( ".isoIndexedRgbaCompatibleToRgbaBlit() used" , dst ) ;
	for ( let i = 0 , imax = this.width * this.height ; i < imax ; i ++ ) {
		let iSrc = i * this.bytesPerPixel ;
		let iDst = i * 4 ;
		let paletteEntry = this.palette[ this.pixelBuffer[ iSrc ] ] ;

		dst[ iDst ] = paletteEntry[ 0 ] ;		// Red
		dst[ iDst + 1 ] = paletteEntry[ 1 ] ;	// Green
		dst[ iDst + 2 ] = paletteEntry[ 2 ] ;	// Blue
		dst[ iDst + 3 ] = paletteEntry[ 3 ] ;	// Alpha
	}
} ;



PortableImage.prototype.updateFromImageData = function( imageData , mapping ) {
	throw new Error( "Not coded!" ) ;

	// /!\ TODO /!\
	/*

	if ( ! mapping ) {
		if ( this.isRgbaCompatible ) { mapping = Mapping.RGBA_COMPATIBLE_TO_RGBA ; }
		else if ( this.isRgbCompatible ) { mapping = Mapping.RGB_COMPATIBLE_TO_RGBA ; }
		else { throw new Error( "Mapping required for image that are not RGB/RGBA compatible" ) ; }
	}

	if ( imageData.width !== this.width || imageData.height !== this.height ) {
		throw new Error( ".updateFromImageData(): width and/or height mismatch" ) ;
	}

	for ( let i = 0 , imax = this.width * this.height ; i < imax ; i ++ ) {
		let iDst = i * this.bytesPerPixel ;
		let iSrc = i * 4 ;

		if ( this.indexed ) {
			let channelValues = [] ;
			channelValues[ iDst + mapping[ 0 ] ] = imageData[ iSrc ] ;
			channelValues[ iDst + mapping[ 1 ] ] = imageData[ iSrc + 1 ] ;
			channelValues[ iDst + mapping[ 2 ] ] = imageData[ iSrc + 2 ] ;
			channelValues[ iDst + mapping[ 3 ] ] = imageData[ iSrc + 3 ] ;

			this.pixelBuffer[ iDst ] = this.getClosestPaletteIndex( channelValues ) ;
		}

		this.pixelBuffer[ iDst + mapping[ 0 ] ] = imageData[ iSrc ] ;
		this.pixelBuffer[ iDst + mapping[ 1 ] ] = imageData[ iSrc + 1 ] ;
		this.pixelBuffer[ iDst + mapping[ 2 ] ] = imageData[ iSrc + 2 ] ;
		this.pixelBuffer[ iDst + mapping[ 3 ] ] = imageData[ iSrc + 3 ] ;
	}
	*/
} ;


}).call(this)}).call(this,require("buffer").Buffer)
},{"./Mapping.js":3,"./compositing.js":5,"buffer":9}],5:[function(require,module,exports){
/*
	Portable Image

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



const compositing = {} ;
module.exports = compositing ;



// The normal alpha-blending mode, a “top” layer replacing a “bottom” one.
compositing.normal = compositing.over = {
	alpha: ( alphaSrc , alphaDst ) => alphaSrc + alphaDst * ( 1 - alphaSrc ) ,
	channel: ( alphaSrc , alphaDst , channelSrc , channelDst ) =>
		( channelSrc * alphaSrc + channelDst * alphaDst * ( 1 - alphaSrc ) ) / ( alphaSrc + alphaDst * ( 1 - alphaSrc ) ) || 0
} ;

// Like normal/over, but alpha is considered fully transparent (=0) or fully opaque (≥1).
compositing.binaryOver = {
	alpha: ( alphaSrc , alphaDst ) => alphaSrc ? 1 : alphaDst ,
	channel: ( alphaSrc , alphaDst , channelSrc , channelDst ) => alphaSrc ? channelSrc : channelDst
} ;

// This intersect the src and the dst for alpha, while using the same method than “over” for the channel.
// The result is opaque only where both are opaque.
compositing.in = {
	alpha: ( alphaSrc , alphaDst ) => alphaSrc * alphaDst ,
	channel: compositing.normal.channel
} ;

// Src is only copied where dst is transparent, it's like a “in” with dst alpha inverted.
compositing.out = {
	alpha: ( alphaSrc , alphaDst ) => alphaSrc * ( 1 - alphaDst ) ,
	channel: ( alphaSrc , alphaDst , channelSrc , channelDst ) =>
		( channelSrc * alphaSrc + channelDst * ( 1 - alphaDst ) * ( 1 - alphaSrc ) ) / ( alphaSrc + ( 1 - alphaDst ) * ( 1 - alphaSrc ) ) || 0
} ;

// Src is only copied where both src and dst are opaque, opaque dst area are left untouched where src is transparent.
// It uses the same method than “over” for the channel.
compositing.atop = {
	alpha: ( alphaSrc , alphaDst ) => compositing.normal.alpha( alphaSrc , alphaDst ) * alphaDst ,
	channel: compositing.normal.channel
} ;

// This use an analogic xor for alpha, while using the same method than “over” for the channel.
// The result is opaque only where only one is opaque.
compositing.xor = {
	alpha: ( alphaSrc , alphaDst ) => alphaSrc * ( 1 - alphaDst ) + alphaDst * ( 1 - alphaSrc ) ,
	channel: compositing.normal.channel
} ;



// Advanced compositing methods.
// See: https://en.wikipedia.org/wiki/Alpha_compositing

// Multiply, always produce darker output
compositing.multiply = {
	alpha: compositing.normal.alpha ,
	channel: ( alphaSrc , alphaDst , channelSrc , channelDst ) => compositing.normal.channel(
		alphaSrc ,
		alphaDst ,
		channelSrc * ( 1 + ( channelDst - 1 ) * alphaDst ) ,
		channelDst
	)
} ;

// Inverse of multiply, always produce brighter output
compositing.screen = {
	alpha: compositing.normal.alpha ,
	channel: ( alphaSrc , alphaDst , channelSrc , channelDst ) => compositing.normal.channel(
		alphaSrc ,
		alphaDst ,
		1 - ( 1 - channelSrc ) * ( 1 - channelDst * alphaDst ) ,
		channelDst
	)
} ;

// Overlay, either a screen or a multiply, with a factor 2.
compositing.overlay = {
	alpha: compositing.normal.alpha ,
	channel: ( alphaSrc , alphaDst , channelSrc , channelDst ) => compositing.normal.channel(
		alphaSrc ,
		alphaDst ,
		// Got trouble making it work with dst alpha channel, the original resources just check if dst < 0.5,
		// I made it three-way to solve issues when dst has low or transparency alpha, so that is color info
		// doesn't affect the blending color.
		1 + ( channelDst - 1 ) * alphaDst < 0.5   ?   2 * channelSrc * ( 1 + ( channelDst - 1 ) * alphaDst )       :
		channelDst * alphaDst > 0.5               ?   1 - 2 * ( 1 - channelSrc ) * ( 1 - channelDst * alphaDst )   :
		channelSrc ,
		channelDst
	)
} ;


},{}],6:[function(require,module,exports){
(function (Buffer){(function (){
/*
	Stream Kit

	Copyright (c) 2016 - 2024 Cédric Ronvel

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



// Bring all the good stuffs of StreamBuffer to regular buffer.



function SequentialReadBuffer( buffer ) {
	this.buffer = buffer ;
	this.ptr = 0 ;

	// Bit reading part
	this.currentBitByte = 0 ;       // current byte where to extract bits
	this.remainingBits = 0 ;    // remaining bits inside the current byte, if 0 there is no byte where to extract bits
}

module.exports = SequentialReadBuffer ;



// Getters
Object.defineProperties( SequentialReadBuffer.prototype , {
	ended: {
		get: function() { return this.ptr >= this.buffer.length ; }
	} ,
	remainingBytes: {
		get: function() { return this.buffer.length - this.ptr ; }
	}
} ) ;



// Skip some bytes we don't have interest in
SequentialReadBuffer.prototype.skip = function( byteLength ) {
	this.remainingBits = this.currentBitByte = 0 ;
	this.ptr += byteLength ;
} ;



SequentialReadBuffer.prototype.readBuffer = function( byteLength , view = false ) {
	this.remainingBits = this.currentBitByte = 0 ;
	var buffer ;

	if ( view ) {
		buffer = this.buffer.slice( this.ptr , this.ptr + byteLength ) ;
	}
	else {
		buffer = Buffer.allocUnsafe( byteLength ) ;
		this.buffer.copy( buffer , 0 , this.ptr , this.ptr + byteLength ) ;
	}

	this.ptr += byteLength ;
	return buffer ;
} ;



SequentialReadBuffer.prototype.readFloat =
SequentialReadBuffer.prototype.readFloatBE = function() {
	this.remainingBits = this.currentBitByte = 0 ;
	var v = this.buffer.readFloatBE( this.ptr ) ;
	this.ptr += 4 ;
	return v ;
} ;

SequentialReadBuffer.prototype.readFloatLE = function() {
	this.remainingBits = this.currentBitByte = 0 ;
	var v = this.buffer.readFloatLE( this.ptr ) ;
	this.ptr += 4 ;
	return v ;
} ;



SequentialReadBuffer.prototype.readNumber =
SequentialReadBuffer.prototype.readDouble =
SequentialReadBuffer.prototype.readDoubleBE = function() {
	this.remainingBits = this.currentBitByte = 0 ;
	var v = this.buffer.readDoubleBE( this.ptr ) ;
	this.ptr += 8 ;
	return v ;
} ;

SequentialReadBuffer.prototype.readDoubleLE = function() {
	this.remainingBits = this.currentBitByte = 0 ;
	var v = this.buffer.readDoubleLE( this.ptr ) ;
	this.ptr += 8 ;
	return v ;
} ;



SequentialReadBuffer.prototype.readUInt8 = function() {
	this.remainingBits = this.currentBitByte = 0 ;
	return this.buffer.readUInt8( this.ptr ++ ) ;
} ;



SequentialReadBuffer.prototype.readUInt16 =
SequentialReadBuffer.prototype.readUInt16BE = function() {
	this.remainingBits = this.currentBitByte = 0 ;
	var v = this.buffer.readUInt16BE( this.ptr ) ;
	this.ptr += 2 ;
	return v ;
} ;

SequentialReadBuffer.prototype.readUInt16LE = function() {
	this.remainingBits = this.currentBitByte = 0 ;
	var v = this.buffer.readUInt16LE( this.ptr ) ;
	this.ptr += 2 ;
	return v ;
} ;



SequentialReadBuffer.prototype.readUInt32 =
SequentialReadBuffer.prototype.readUInt32BE = function() {
	this.remainingBits = this.currentBitByte = 0 ;
	var v = this.buffer.readUInt32BE( this.ptr ) ;
	this.ptr += 4 ;
	return v ;
} ;

SequentialReadBuffer.prototype.readUInt32LE = function() {
	this.remainingBits = this.currentBitByte = 0 ;
	var v = this.buffer.readUInt32LE( this.ptr ) ;
	this.ptr += 4 ;
	return v ;
} ;



SequentialReadBuffer.prototype.readUInt64 =
SequentialReadBuffer.prototype.readUInt64BE = function() {
	this.remainingBits = this.currentBitByte = 0 ;
	var v = this.buffer.readBigUInt64BE( this.ptr ) ;
	this.ptr += 8 ;
	return v ;
} ;

SequentialReadBuffer.prototype.readUInt64LE = function() {
	this.remainingBits = this.currentBitByte = 0 ;
	var v = this.buffer.readBigUInt64LE( this.ptr ) ;
	this.ptr += 8 ;
	return v ;
} ;



SequentialReadBuffer.prototype.readInt8 = function() {
	this.remainingBits = this.currentBitByte = 0 ;
	return this.buffer.readInt8( this.ptr ++ ) ;
} ;



SequentialReadBuffer.prototype.readInt16 =
SequentialReadBuffer.prototype.readInt16BE = function() {
	this.remainingBits = this.currentBitByte = 0 ;
	var v = this.buffer.readInt16BE( this.ptr ) ;
	this.ptr += 2 ;
	return v ;
} ;

SequentialReadBuffer.prototype.readInt16LE = function() {
	this.remainingBits = this.currentBitByte = 0 ;
	var v = this.buffer.readInt16LE( this.ptr ) ;
	this.ptr += 2 ;
	return v ;
} ;



SequentialReadBuffer.prototype.readInt32 =
SequentialReadBuffer.prototype.readInt32BE = function() {
	this.remainingBits = this.currentBitByte = 0 ;
	var v = this.buffer.readInt32BE( this.ptr ) ;
	this.ptr += 4 ;
	return v ;
} ;

SequentialReadBuffer.prototype.readInt32LE = function() {
	this.remainingBits = this.currentBitByte = 0 ;
	var v = this.buffer.readInt32LE( this.ptr ) ;
	this.ptr += 4 ;
	return v ;
} ;



SequentialReadBuffer.prototype.readInt64 =
SequentialReadBuffer.prototype.readInt64BE = function() {
	this.remainingBits = this.currentBitByte = 0 ;
	var v = this.buffer.readBigInt64BE( this.ptr ) ;
	this.ptr += 8 ;
	return v ;
} ;

SequentialReadBuffer.prototype.readInt64LE = function() {
	this.remainingBits = this.currentBitByte = 0 ;
	var v = this.buffer.readBigInt64LE( this.ptr ) ;
	this.ptr += 8 ;
	return v ;
} ;



SequentialReadBuffer.prototype.readString = function( byteLength , encoding = 'latin1' ) {
	this.remainingBits = this.currentBitByte = 0 ;
	var v = this.buffer.toString( encoding , this.ptr , this.ptr + byteLength ) ;
	this.ptr += byteLength ;
	return v ;
} ;

SequentialReadBuffer.prototype.readUtf8 = function( byteLength ) { return this.readString( byteLength , 'utf8' ) ; } ;



// LPS: Length Prefixed String.
// Read the UTF8 BYTE LENGTH using an UInt8.
SequentialReadBuffer.prototype.readLps8String = function( encoding = 'latin1' ) {
	// Read the LPS
	var byteLength = this.readUInt8() ;
	return this.readString( byteLength , encoding ) ;
} ;

SequentialReadBuffer.prototype.readLps8Utf8 = function() { return this.readLps8String( 'utf8' ) ; } ;



SequentialReadBuffer.prototype.readLps16String =
SequentialReadBuffer.prototype.readLps16BEString = function( encoding = 'latin1' ) {
	// Read the LPS
	var byteLength = this.readUInt16() ;
	return this.readString( byteLength , encoding ) ;
} ;

SequentialReadBuffer.prototype.readLps16Utf8 = SequentialReadBuffer.prototype.readLps16BEUtf8 = function() { return this.readLps16String( 'utf8' ) ; } ;

SequentialReadBuffer.prototype.readLps16LEString = function( encoding = 'latin1' ) {
	// Read the LPS
	var byteLength = this.readUInt16LE() ;
	return this.readString( byteLength , encoding ) ;
} ;

SequentialReadBuffer.prototype.readLps16LEUtf8 = function() { return this.readLps16LEString( 'utf8' ) ; } ;



SequentialReadBuffer.prototype.readLps32String =
SequentialReadBuffer.prototype.readLps32BEString = function( encoding = 'latin1' ) {
	// Read the LPS
	var byteLength = this.readUInt32() ;
	return this.readString( byteLength , encoding ) ;
} ;

SequentialReadBuffer.prototype.readLps32Utf8 = SequentialReadBuffer.prototype.readLps32BEUtf8 = function() { return this.readLps32String( 'utf8' ) ; } ;

SequentialReadBuffer.prototype.readLps32LEString = function( encoding = 'latin1' ) {
	// Read the LPS
	var byteLength = this.readUInt32LE() ;
	return this.readString( byteLength , encoding ) ;
} ;

SequentialReadBuffer.prototype.readLps32LEUtf8 = function() { return this.readLps32LEString( 'utf8' ) ; } ;



SequentialReadBuffer.prototype.readNullTerminatedString = function( encoding = 'latin1' ) {
	this.remainingBits = this.currentBitByte = 0 ;

	var end = this.ptr ;

	for ( ; end < this.buffer.length ; end ++ ) {
		if ( this.buffer[ end ] === 0 ) {
			let v = this.buffer.toString( encoding , this.ptr , end ) ;
			this.ptr = end + 1 ;
			return v ;
		}
	}

	this.ptr = end ;
	throw new Error( "Can't find the null terminator for the string" ) ;
} ;

SequentialReadBuffer.prototype.readNullTerminatedUtf8 = function() { return this.readNullTerminatedString( 'utf8' ) ; } ;



// Extract Buffer (copy, non-overlapping memory)

SequentialReadBuffer.prototype.readLps8Buffer = function() {
	var byteLength = this.readUInt8() ;
	return this.readBuffer( byteLength ) ;
} ;



SequentialReadBuffer.prototype.readLps16Buffer =
SequentialReadBuffer.prototype.readLps16BEBuffer = function() {
	var byteLength = this.readUInt16() ;
	return this.readBuffer( byteLength ) ;
} ;

SequentialReadBuffer.prototype.readLps16LEBuffer = function() {
	var byteLength = this.readUInt16LE() ;
	return this.readBuffer( byteLength ) ;
} ;



SequentialReadBuffer.prototype.readLps32Buffer =
SequentialReadBuffer.prototype.readLps32BEBuffer = function() {
	var byteLength = this.readUInt32() ;
	return this.readBuffer( byteLength ) ;
} ;

SequentialReadBuffer.prototype.readLps32LEBuffer = function() {
	var byteLength = this.readUInt32LE() ;
	return this.readBuffer( byteLength ) ;
} ;



const COUNT_BIT_MASK = [
	0 ,
	0b1 ,
	0b11 ,
	0b111 ,
	0b1111 ,
	0b11111 ,
	0b111111 ,
	0b1111111 ,
	0b11111111
] ;



// Read unsigned bits
SequentialReadBuffer.prototype.readUBits =
SequentialReadBuffer.prototype.readUBitsBE = function( bitCount ) {
	if ( bitCount > 8 || bitCount < 1 ) {
		throw new Error( "SequentialReadBuffer#readUBits() expecting bitCount to be between 1 and 8 but got: " + bitCount ) ;
	}

	if ( ! this.remainingBits ) {
		this.currentBitByte = this.buffer.readUInt8( this.ptr ) ;
		let v = this.currentBitByte >> 8 - bitCount ;
		this.remainingBits = 8 - bitCount ;
		this.ptr ++ ;
		return v ;
	}

	if ( bitCount <= this.remainingBits ) {
		// Enough bits in the current byte
		let v = ( this.currentBitByte >> this.remainingBits - bitCount ) & COUNT_BIT_MASK[ bitCount ] ;
		this.remainingBits -= bitCount ;
		return v ;
	}

	// It's splitted in two parts
	let bitCountLeftOver = bitCount - this.remainingBits ;
	let leftV = ( this.currentBitByte & COUNT_BIT_MASK[ this.remainingBits ] ) << bitCountLeftOver ;

	this.currentBitByte = this.buffer.readUInt8( this.ptr ) ;
	let rightV = this.currentBitByte >> 8 - bitCountLeftOver ;
	this.remainingBits = 8 - bitCountLeftOver ;
	this.ptr ++ ;

	return leftV + rightV ;
} ;


}).call(this)}).call(this,require("buffer").Buffer)
},{"buffer":9}],7:[function(require,module,exports){
(function (Buffer){(function (){
/*
	Stream Kit

	Copyright (c) 2016 - 2024 Cédric Ronvel

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



// Bring all the good stuffs of StreamBuffer to regular buffer.
// It will manage an auto-growing buffer.



function SequentialWriteBuffer( chunkSize = 1024 , chunkSizeMultiplier = 1.5 ) {
	this.chunkSize = chunkSize ;
	this.chunkSizeMultiplier = chunkSizeMultiplier ;
	this.buffer = Buffer.allocUnsafe( this.chunkSize ) ;
	this.ptr = 0 ;
	this.chunks = [] ;
	this.allChunksSize = 0 ;

	// Bit writing part
	this.currentBitByte = 0 ;		// current byte where to push bits
	this.remainingBits = 0 ;	// remaining bits inside the current byte, if 0 there is no byte where to put bits
}

module.exports = SequentialWriteBuffer ;



SequentialWriteBuffer.prototype.size = function() { return this.allChunksSize + this.ptr ; } ;



SequentialWriteBuffer.prototype.getBuffer = function( view = false ) {
	if ( ! this.chunks.length ) {
		let slice = this.buffer.slice( 0 , this.ptr ) ;
		if ( view ) { return slice ; }
		return Buffer.from( slice ) ;
	}

	if ( ! this.ptr ) { return Buffer.concat( this.chunks ) ; }
	return Buffer.concat( [ ... this.chunks , this.buffer.slice( 0 , this.ptr ) ] ) ;
} ;



// Ensure that we can write that length to the current buffer, or create a new one
SequentialWriteBuffer.prototype.ensureBytes = function( byteLength ) {
	// Always reset bits
	this.remainingBits = 0 ;
	this.currentBitByte = 0 ;

	if ( byteLength <= this.buffer.length - this.ptr ) { return ; }

	this.chunks.push( this.buffer.slice( 0 , this.ptr ) ) ;
	this.allChunksSize += this.ptr ;

	// The next chunk wil be larger, to avoid allocation of too much buffers,
	// it also should at least be large enough for the next write.
	this.chunkSize = Math.ceil( Math.max( byteLength , this.chunkSize * this.chunkSizeMultiplier ) ) ;

	this.buffer = Buffer.allocUnsafe( this.chunkSize ) ;
	this.ptr = 0 ;
} ;



SequentialWriteBuffer.prototype.writeBuffer = function( buffer , start = 0 , end = buffer.length ) {
	var byteLength = end - start ;
	this.ensureBytes( byteLength ) ;
	buffer.copy( this.buffer , this.ptr , start , end ) ;
	this.ptr += byteLength ;
} ;



SequentialWriteBuffer.prototype.writeFloat =
SequentialWriteBuffer.prototype.writeFloatBE = function( v ) {
	this.ensureBytes( 4 ) ;
	this.buffer.writeFloatBE( v , this.ptr ) ;
	this.ptr += 4 ;
} ;

SequentialWriteBuffer.prototype.writeFloatLE = function( v ) {
	this.ensureBytes( 4 ) ;
	this.buffer.writeFloatLE( v , this.ptr ) ;
	this.ptr += 4 ;
} ;



SequentialWriteBuffer.prototype.writeNumber =
SequentialWriteBuffer.prototype.writeDouble =
SequentialWriteBuffer.prototype.writeDoubleBE = function( v ) {
	this.ensureBytes( 8 ) ;
	this.buffer.writeDoubleBE( v , this.ptr ) ;
	this.ptr += 8 ;
} ;

SequentialWriteBuffer.prototype.writeDoubleLE = function( v ) {
	this.ensureBytes( 8 ) ;
	this.buffer.writeDoubleLE( v , this.ptr ) ;
	this.ptr += 8 ;
} ;



SequentialWriteBuffer.prototype.writeUInt8 = function( v ) {
	this.ensureBytes( 1 ) ;
	this.buffer.writeUInt8( v , this.ptr ) ;
	this.ptr ++ ;
} ;



SequentialWriteBuffer.prototype.writeUInt16 =
SequentialWriteBuffer.prototype.writeUInt16BE = function( v ) {
	this.ensureBytes( 2 ) ;
	this.buffer.writeUInt16BE( v , this.ptr ) ;
	this.ptr += 2 ;
} ;

SequentialWriteBuffer.prototype.writeUInt16LE = function( v ) {
	this.ensureBytes( 2 ) ;
	this.buffer.writeUInt16LE( v , this.ptr ) ;
	this.ptr += 2 ;
} ;



SequentialWriteBuffer.prototype.writeUInt32 =
SequentialWriteBuffer.prototype.writeUInt32BE = function( v ) {
	this.ensureBytes( 4 ) ;
	this.buffer.writeUInt32BE( v , this.ptr ) ;
	this.ptr += 4 ;
} ;

SequentialWriteBuffer.prototype.writeUInt32LE = function( v ) {
	this.ensureBytes( 4 ) ;
	this.buffer.writeUInt32LE( v , this.ptr ) ;
	this.ptr += 4 ;
} ;



SequentialWriteBuffer.prototype.writeUInt64 =
SequentialWriteBuffer.prototype.writeUInt64BE = function( v ) {
	this.ensureBytes( 8 ) ;
	this.buffer.writeBigUInt64BE( v , this.ptr ) ;
	this.ptr += 8 ;
} ;

SequentialWriteBuffer.prototype.writeUInt64LE = function( v ) {
	this.ensureBytes( 8 ) ;
	this.buffer.writeBigUInt64LE( v , this.ptr ) ;
	this.ptr += 8 ;
} ;



SequentialWriteBuffer.prototype.writeInt8 = function( v ) {
	this.ensureBytes( 1 ) ;
	this.buffer.writeInt8( v , this.ptr ) ;
	this.ptr ++ ;
} ;



SequentialWriteBuffer.prototype.writeInt16 =
SequentialWriteBuffer.prototype.writeInt16BE = function( v ) {
	this.ensureBytes( 2 ) ;
	this.buffer.writeInt16BE( v , this.ptr ) ;
	this.ptr += 2 ;
} ;

SequentialWriteBuffer.prototype.writeInt16LE = function( v ) {
	this.ensureBytes( 2 ) ;
	this.buffer.writeInt16LE( v , this.ptr ) ;
	this.ptr += 2 ;
} ;



SequentialWriteBuffer.prototype.writeInt32 =
SequentialWriteBuffer.prototype.writeInt32BE = function( v ) {
	this.ensureBytes( 4 ) ;
	this.buffer.writeInt32BE( v , this.ptr ) ;
	this.ptr += 4 ;
} ;

SequentialWriteBuffer.prototype.writeInt32LE = function( v ) {
	this.ensureBytes( 4 ) ;
	this.buffer.writeInt32LE( v , this.ptr ) ;
	this.ptr += 4 ;
} ;



SequentialWriteBuffer.prototype.writeInt64 =
SequentialWriteBuffer.prototype.writeInt64BE = function( v ) {
	this.ensureBytes( 8 ) ;
	this.buffer.writeBigInt64BE( v , this.ptr ) ;
	this.ptr += 8 ;
} ;

SequentialWriteBuffer.prototype.writeInt64LE = function( v ) {
	this.ensureBytes( 8 ) ;
	this.buffer.writeBigInt64LE( v , this.ptr ) ;
	this.ptr += 8 ;
} ;



SequentialWriteBuffer.prototype.writeString = function( v , byteLength , encoding = 'latin1' ) {
	if ( byteLength === undefined ) {
		byteLength = Buffer.byteLength( v , encoding ) ;
	}

	this.ensureBytes( byteLength ) ;
	this.buffer.write( v , this.ptr , byteLength , encoding ) ;
	this.ptr += byteLength ;
} ;

SequentialWriteBuffer.prototype.writeUtf8 = function( v , byteLength ) { return this.writeString( v , byteLength , 'utf8' ) ; } ;



// LPS: Length prefixed string.
// Store the UTF8 BYTE LENGTH using an UInt8.
// Computing byteLength is probably costly, so if the upper layer know it, it can saves some cycles
SequentialWriteBuffer.prototype.writeLps8String = function( v , byteLength , encoding = 'latin1' ) {
	if ( byteLength === undefined ) {
		byteLength = Buffer.byteLength( v , encoding ) ;
	}

	if ( byteLength > 255 ) {
		// Error! What should we do?
		throw new RangeError( 'The string exceed the LPS 8 bits limit' ) ;
	}

	// Write the LPS
	this.writeUInt8( byteLength ) ;
	this.writeString( v , byteLength , encoding ) ;
} ;

SequentialWriteBuffer.prototype.writeLps8Utf8 = function( v , byteLength ) { return this.writeLps8String( v , byteLength , 'utf8' ) ; } ;


SequentialWriteBuffer.prototype.writeLps16String =
SequentialWriteBuffer.prototype.writeLps16BEString = function( v , byteLength , encoding = 'latin1' ) {
	if ( byteLength === undefined ) {
		byteLength = Buffer.byteLength( v , encoding ) ;
	}

	if ( byteLength > 65535 ) {
		// Error! What should we do?
		throw new RangeError( 'The string exceed the LPS 16 bits limit' ) ;
	}

	// Write the LPS
	this.writeUInt16( byteLength ) ;
	this.writeString( v , byteLength , encoding ) ;
} ;

SequentialWriteBuffer.prototype.writeLps16Utf8 = SequentialWriteBuffer.prototype.writeLps16BEUtf8 = function( v , byteLength ) { return this.writeLps16String( v , byteLength , 'utf8' ) ; } ;

SequentialWriteBuffer.prototype.writeLps16LEString = function( v , byteLength , encoding = 'latin1' ) {
	if ( byteLength === undefined ) {
		byteLength = Buffer.byteLength( v , encoding ) ;
	}

	if ( byteLength > 65535 ) {
		// Error! What should we do?
		throw new RangeError( 'The string exceed the LPS 16 bits limit' ) ;
	}

	// Write the LPS
	this.writeUInt16LE( byteLength ) ;
	this.writeString( v , byteLength , encoding ) ;
} ;

SequentialWriteBuffer.prototype.writeLps16LEUtf8 = function( v , byteLength ) { return this.writeLps16LEString( v , byteLength , 'utf8' ) ; } ;



SequentialWriteBuffer.prototype.writeLps32String =
SequentialWriteBuffer.prototype.writeLps32BEString = function( v , byteLength , encoding = 'latin1' ) {
	if ( byteLength === undefined ) {
		byteLength = Buffer.byteLength( v , encoding ) ;
	}

	// Write the LPS
	this.writeUInt32( byteLength ) ;
	this.writeString( v , byteLength , encoding ) ;
} ;

SequentialWriteBuffer.prototype.writeLps32Utf8 = SequentialWriteBuffer.prototype.writeLps32BEUtf8 = function( v , byteLength ) { return this.writeLps32String( v , byteLength , 'utf8' ) ; } ;

SequentialWriteBuffer.prototype.writeLps32LEString = function( v , byteLength , encoding = 'latin1' ) {
	if ( byteLength === undefined ) {
		byteLength = Buffer.byteLength( v , encoding ) ;
	}

	// Write the LPS
	this.writeUInt32LE( byteLength ) ;
	this.writeString( v , byteLength , encoding ) ;
} ;

SequentialWriteBuffer.prototype.writeLps32LEUtf8 = function( v , byteLength ) { return this.writeLps32LEString( v , byteLength , 'utf8' ) ; } ;



SequentialWriteBuffer.prototype.writeNullTerminatedString = function( v , encoding = 'latin1' ) {
	if ( v.includes( '\x00' ) ) {
		throw new Error( "The string already contains the NUL character, which is forbidden inside a null-terminated string" ) ;
	}

	v += '\x00' ;
	var byteLength = Buffer.byteLength( v , encoding ) ;

	this.ensureBytes( byteLength ) ;
	this.buffer.write( v , this.ptr , byteLength , encoding ) ;
	this.ptr += byteLength ;
} ;

SequentialWriteBuffer.prototype.writeNullTerminatedUtf8 = function( v ) { return this.writeNullTerminatedString( v , 'utf8' ) ; } ;



SequentialWriteBuffer.prototype.writeLps8Buffer = function( v ) {
	if ( v.length > 255 ) { throw new RangeError( 'The buffer exceed the LPS 8 bits limit' ) ; }
	this.writeUInt8( v.length ) ;
	this.writeBuffer( v ) ;
} ;



SequentialWriteBuffer.prototype.writeLps16Buffer =
SequentialWriteBuffer.prototype.writeLps16BEBuffer = function( v ) {
	if ( v.length > 65535 ) { throw new RangeError( 'The buffer exceed the LPS 16 bits limit' ) ; }
	this.writeUInt16( v.length ) ;
	this.writeBuffer( v ) ;
} ;

SequentialWriteBuffer.prototype.writeLps16LEBuffer = function( v ) {
	if ( v.length > 65535 ) { throw new RangeError( 'The buffer exceed the LPS 16 bits limit' ) ; }
	this.writeUInt16LE( v.length ) ;
	this.writeBuffer( v ) ;
} ;



SequentialWriteBuffer.prototype.writeLps32Buffer =
SequentialWriteBuffer.prototype.writeLps32BEBuffer = function( v ) {
	this.writeUInt32( v.length ) ;
	this.writeBuffer( v ) ;
} ;

SequentialWriteBuffer.prototype.writeLps32LEBuffer = function( v ) {
	this.writeUInt32LE( v.length ) ;
	this.writeBuffer( v ) ;
} ;



const COUNT_BIT_MASK = [
	0 ,
	0b1 ,
	0b11 ,
	0b111 ,
	0b1111 ,
	0b11111 ,
	0b111111 ,
	0b1111111 ,
	0b11111111
] ;



// Write unsigned bits
SequentialWriteBuffer.prototype.writeUBits =
SequentialWriteBuffer.prototype.writeUBitsBE = function( v , bitCount ) {
	if ( bitCount > 8 || bitCount < 1 ) {
		throw new Error( "SequentialWriteBuffer#writeUBits() expecting bitCount to be between 1 and 8 but got: " + bitCount ) ;
	}

	v &= COUNT_BIT_MASK[ bitCount ] ;

	if ( ! this.remainingBits ) {
		// Use a new byte, and since we write at most 8 bits, we are good to go
		this.ensureBytes( 1 ) ;		// reset currentBitByte and remainingBits
		this.currentBitByte = v << 8 - bitCount ;
		this.remainingBits = 8 - bitCount ;
		this.buffer.writeUInt8( this.currentBitByte , this.ptr ) ;
		this.ptr ++ ;
		return ;
	}

	if ( bitCount <= this.remainingBits ) {
		// Enough bits in the current byte
		this.currentBitByte |= v << this.remainingBits - bitCount ;
		this.remainingBits -= bitCount ;
		this.buffer.writeUInt8( this.currentBitByte , this.ptr - 1 ) ;	// Write on the previous byte
		return ;
	}

	// Split in two parts
	let bitCountLeftOver = bitCount - this.remainingBits ;
	let leftV = v >> bitCountLeftOver ;
	let rightV = v & COUNT_BIT_MASK[ bitCountLeftOver ] ;

	this.currentBitByte |= leftV ;
	this.buffer.writeUInt8( this.currentBitByte , this.ptr - 1 ) ;	// Write on the previous byte

	this.ensureBytes( 1 ) ;		// reset currentBitByte and remainingBits
	this.currentBitByte = rightV << 8 - bitCountLeftOver ;
	this.remainingBits = 8 - bitCountLeftOver ;
	this.buffer.writeUInt8( this.currentBitByte , this.ptr ) ;
	this.ptr ++ ;
} ;


}).call(this)}).call(this,require("buffer").Buffer)
},{"buffer":9}],8:[function(require,module,exports){
'use strict'

exports.byteLength = byteLength
exports.toByteArray = toByteArray
exports.fromByteArray = fromByteArray

var lookup = []
var revLookup = []
var Arr = typeof Uint8Array !== 'undefined' ? Uint8Array : Array

var code = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
for (var i = 0, len = code.length; i < len; ++i) {
  lookup[i] = code[i]
  revLookup[code.charCodeAt(i)] = i
}

// Support decoding URL-safe base64 strings, as Node.js does.
// See: https://en.wikipedia.org/wiki/Base64#URL_applications
revLookup['-'.charCodeAt(0)] = 62
revLookup['_'.charCodeAt(0)] = 63

function getLens (b64) {
  var len = b64.length

  if (len % 4 > 0) {
    throw new Error('Invalid string. Length must be a multiple of 4')
  }

  // Trim off extra bytes after placeholder bytes are found
  // See: https://github.com/beatgammit/base64-js/issues/42
  var validLen = b64.indexOf('=')
  if (validLen === -1) validLen = len

  var placeHoldersLen = validLen === len
    ? 0
    : 4 - (validLen % 4)

  return [validLen, placeHoldersLen]
}

// base64 is 4/3 + up to two characters of the original data
function byteLength (b64) {
  var lens = getLens(b64)
  var validLen = lens[0]
  var placeHoldersLen = lens[1]
  return ((validLen + placeHoldersLen) * 3 / 4) - placeHoldersLen
}

function _byteLength (b64, validLen, placeHoldersLen) {
  return ((validLen + placeHoldersLen) * 3 / 4) - placeHoldersLen
}

function toByteArray (b64) {
  var tmp
  var lens = getLens(b64)
  var validLen = lens[0]
  var placeHoldersLen = lens[1]

  var arr = new Arr(_byteLength(b64, validLen, placeHoldersLen))

  var curByte = 0

  // if there are placeholders, only get up to the last complete 4 chars
  var len = placeHoldersLen > 0
    ? validLen - 4
    : validLen

  var i
  for (i = 0; i < len; i += 4) {
    tmp =
      (revLookup[b64.charCodeAt(i)] << 18) |
      (revLookup[b64.charCodeAt(i + 1)] << 12) |
      (revLookup[b64.charCodeAt(i + 2)] << 6) |
      revLookup[b64.charCodeAt(i + 3)]
    arr[curByte++] = (tmp >> 16) & 0xFF
    arr[curByte++] = (tmp >> 8) & 0xFF
    arr[curByte++] = tmp & 0xFF
  }

  if (placeHoldersLen === 2) {
    tmp =
      (revLookup[b64.charCodeAt(i)] << 2) |
      (revLookup[b64.charCodeAt(i + 1)] >> 4)
    arr[curByte++] = tmp & 0xFF
  }

  if (placeHoldersLen === 1) {
    tmp =
      (revLookup[b64.charCodeAt(i)] << 10) |
      (revLookup[b64.charCodeAt(i + 1)] << 4) |
      (revLookup[b64.charCodeAt(i + 2)] >> 2)
    arr[curByte++] = (tmp >> 8) & 0xFF
    arr[curByte++] = tmp & 0xFF
  }

  return arr
}

function tripletToBase64 (num) {
  return lookup[num >> 18 & 0x3F] +
    lookup[num >> 12 & 0x3F] +
    lookup[num >> 6 & 0x3F] +
    lookup[num & 0x3F]
}

function encodeChunk (uint8, start, end) {
  var tmp
  var output = []
  for (var i = start; i < end; i += 3) {
    tmp =
      ((uint8[i] << 16) & 0xFF0000) +
      ((uint8[i + 1] << 8) & 0xFF00) +
      (uint8[i + 2] & 0xFF)
    output.push(tripletToBase64(tmp))
  }
  return output.join('')
}

function fromByteArray (uint8) {
  var tmp
  var len = uint8.length
  var extraBytes = len % 3 // if we have 1 byte left, pad 2 bytes
  var parts = []
  var maxChunkLength = 16383 // must be multiple of 3

  // go through the array every three bytes, we'll deal with trailing stuff later
  for (var i = 0, len2 = len - extraBytes; i < len2; i += maxChunkLength) {
    parts.push(encodeChunk(uint8, i, (i + maxChunkLength) > len2 ? len2 : (i + maxChunkLength)))
  }

  // pad the end with zeros, but make sure to not forget the extra bytes
  if (extraBytes === 1) {
    tmp = uint8[len - 1]
    parts.push(
      lookup[tmp >> 2] +
      lookup[(tmp << 4) & 0x3F] +
      '=='
    )
  } else if (extraBytes === 2) {
    tmp = (uint8[len - 2] << 8) + uint8[len - 1]
    parts.push(
      lookup[tmp >> 10] +
      lookup[(tmp >> 4) & 0x3F] +
      lookup[(tmp << 2) & 0x3F] +
      '='
    )
  }

  return parts.join('')
}

},{}],9:[function(require,module,exports){
(function (Buffer){(function (){
/*!
 * The buffer module from node.js, for the browser.
 *
 * @author   Feross Aboukhadijeh <https://feross.org>
 * @license  MIT
 */
/* eslint-disable no-proto */

'use strict'

var base64 = require('base64-js')
var ieee754 = require('ieee754')

exports.Buffer = Buffer
exports.SlowBuffer = SlowBuffer
exports.INSPECT_MAX_BYTES = 50

var K_MAX_LENGTH = 0x7fffffff
exports.kMaxLength = K_MAX_LENGTH

/**
 * If `Buffer.TYPED_ARRAY_SUPPORT`:
 *   === true    Use Uint8Array implementation (fastest)
 *   === false   Print warning and recommend using `buffer` v4.x which has an Object
 *               implementation (most compatible, even IE6)
 *
 * Browsers that support typed arrays are IE 10+, Firefox 4+, Chrome 7+, Safari 5.1+,
 * Opera 11.6+, iOS 4.2+.
 *
 * We report that the browser does not support typed arrays if the are not subclassable
 * using __proto__. Firefox 4-29 lacks support for adding new properties to `Uint8Array`
 * (See: https://bugzilla.mozilla.org/show_bug.cgi?id=695438). IE 10 lacks support
 * for __proto__ and has a buggy typed array implementation.
 */
Buffer.TYPED_ARRAY_SUPPORT = typedArraySupport()

if (!Buffer.TYPED_ARRAY_SUPPORT && typeof console !== 'undefined' &&
    typeof console.error === 'function') {
  console.error(
    'This browser lacks typed array (Uint8Array) support which is required by ' +
    '`buffer` v5.x. Use `buffer` v4.x if you require old browser support.'
  )
}

function typedArraySupport () {
  // Can typed array instances can be augmented?
  try {
    var arr = new Uint8Array(1)
    arr.__proto__ = { __proto__: Uint8Array.prototype, foo: function () { return 42 } }
    return arr.foo() === 42
  } catch (e) {
    return false
  }
}

Object.defineProperty(Buffer.prototype, 'parent', {
  enumerable: true,
  get: function () {
    if (!Buffer.isBuffer(this)) return undefined
    return this.buffer
  }
})

Object.defineProperty(Buffer.prototype, 'offset', {
  enumerable: true,
  get: function () {
    if (!Buffer.isBuffer(this)) return undefined
    return this.byteOffset
  }
})

function createBuffer (length) {
  if (length > K_MAX_LENGTH) {
    throw new RangeError('The value "' + length + '" is invalid for option "size"')
  }
  // Return an augmented `Uint8Array` instance
  var buf = new Uint8Array(length)
  buf.__proto__ = Buffer.prototype
  return buf
}

/**
 * The Buffer constructor returns instances of `Uint8Array` that have their
 * prototype changed to `Buffer.prototype`. Furthermore, `Buffer` is a subclass of
 * `Uint8Array`, so the returned instances will have all the node `Buffer` methods
 * and the `Uint8Array` methods. Square bracket notation works as expected -- it
 * returns a single octet.
 *
 * The `Uint8Array` prototype remains unmodified.
 */

function Buffer (arg, encodingOrOffset, length) {
  // Common case.
  if (typeof arg === 'number') {
    if (typeof encodingOrOffset === 'string') {
      throw new TypeError(
        'The "string" argument must be of type string. Received type number'
      )
    }
    return allocUnsafe(arg)
  }
  return from(arg, encodingOrOffset, length)
}

// Fix subarray() in ES2016. See: https://github.com/feross/buffer/pull/97
if (typeof Symbol !== 'undefined' && Symbol.species != null &&
    Buffer[Symbol.species] === Buffer) {
  Object.defineProperty(Buffer, Symbol.species, {
    value: null,
    configurable: true,
    enumerable: false,
    writable: false
  })
}

Buffer.poolSize = 8192 // not used by this implementation

function from (value, encodingOrOffset, length) {
  if (typeof value === 'string') {
    return fromString(value, encodingOrOffset)
  }

  if (ArrayBuffer.isView(value)) {
    return fromArrayLike(value)
  }

  if (value == null) {
    throw TypeError(
      'The first argument must be one of type string, Buffer, ArrayBuffer, Array, ' +
      'or Array-like Object. Received type ' + (typeof value)
    )
  }

  if (isInstance(value, ArrayBuffer) ||
      (value && isInstance(value.buffer, ArrayBuffer))) {
    return fromArrayBuffer(value, encodingOrOffset, length)
  }

  if (typeof value === 'number') {
    throw new TypeError(
      'The "value" argument must not be of type number. Received type number'
    )
  }

  var valueOf = value.valueOf && value.valueOf()
  if (valueOf != null && valueOf !== value) {
    return Buffer.from(valueOf, encodingOrOffset, length)
  }

  var b = fromObject(value)
  if (b) return b

  if (typeof Symbol !== 'undefined' && Symbol.toPrimitive != null &&
      typeof value[Symbol.toPrimitive] === 'function') {
    return Buffer.from(
      value[Symbol.toPrimitive]('string'), encodingOrOffset, length
    )
  }

  throw new TypeError(
    'The first argument must be one of type string, Buffer, ArrayBuffer, Array, ' +
    'or Array-like Object. Received type ' + (typeof value)
  )
}

/**
 * Functionally equivalent to Buffer(arg, encoding) but throws a TypeError
 * if value is a number.
 * Buffer.from(str[, encoding])
 * Buffer.from(array)
 * Buffer.from(buffer)
 * Buffer.from(arrayBuffer[, byteOffset[, length]])
 **/
Buffer.from = function (value, encodingOrOffset, length) {
  return from(value, encodingOrOffset, length)
}

// Note: Change prototype *after* Buffer.from is defined to workaround Chrome bug:
// https://github.com/feross/buffer/pull/148
Buffer.prototype.__proto__ = Uint8Array.prototype
Buffer.__proto__ = Uint8Array

function assertSize (size) {
  if (typeof size !== 'number') {
    throw new TypeError('"size" argument must be of type number')
  } else if (size < 0) {
    throw new RangeError('The value "' + size + '" is invalid for option "size"')
  }
}

function alloc (size, fill, encoding) {
  assertSize(size)
  if (size <= 0) {
    return createBuffer(size)
  }
  if (fill !== undefined) {
    // Only pay attention to encoding if it's a string. This
    // prevents accidentally sending in a number that would
    // be interpretted as a start offset.
    return typeof encoding === 'string'
      ? createBuffer(size).fill(fill, encoding)
      : createBuffer(size).fill(fill)
  }
  return createBuffer(size)
}

/**
 * Creates a new filled Buffer instance.
 * alloc(size[, fill[, encoding]])
 **/
Buffer.alloc = function (size, fill, encoding) {
  return alloc(size, fill, encoding)
}

function allocUnsafe (size) {
  assertSize(size)
  return createBuffer(size < 0 ? 0 : checked(size) | 0)
}

/**
 * Equivalent to Buffer(num), by default creates a non-zero-filled Buffer instance.
 * */
Buffer.allocUnsafe = function (size) {
  return allocUnsafe(size)
}
/**
 * Equivalent to SlowBuffer(num), by default creates a non-zero-filled Buffer instance.
 */
Buffer.allocUnsafeSlow = function (size) {
  return allocUnsafe(size)
}

function fromString (string, encoding) {
  if (typeof encoding !== 'string' || encoding === '') {
    encoding = 'utf8'
  }

  if (!Buffer.isEncoding(encoding)) {
    throw new TypeError('Unknown encoding: ' + encoding)
  }

  var length = byteLength(string, encoding) | 0
  var buf = createBuffer(length)

  var actual = buf.write(string, encoding)

  if (actual !== length) {
    // Writing a hex string, for example, that contains invalid characters will
    // cause everything after the first invalid character to be ignored. (e.g.
    // 'abxxcd' will be treated as 'ab')
    buf = buf.slice(0, actual)
  }

  return buf
}

function fromArrayLike (array) {
  var length = array.length < 0 ? 0 : checked(array.length) | 0
  var buf = createBuffer(length)
  for (var i = 0; i < length; i += 1) {
    buf[i] = array[i] & 255
  }
  return buf
}

function fromArrayBuffer (array, byteOffset, length) {
  if (byteOffset < 0 || array.byteLength < byteOffset) {
    throw new RangeError('"offset" is outside of buffer bounds')
  }

  if (array.byteLength < byteOffset + (length || 0)) {
    throw new RangeError('"length" is outside of buffer bounds')
  }

  var buf
  if (byteOffset === undefined && length === undefined) {
    buf = new Uint8Array(array)
  } else if (length === undefined) {
    buf = new Uint8Array(array, byteOffset)
  } else {
    buf = new Uint8Array(array, byteOffset, length)
  }

  // Return an augmented `Uint8Array` instance
  buf.__proto__ = Buffer.prototype
  return buf
}

function fromObject (obj) {
  if (Buffer.isBuffer(obj)) {
    var len = checked(obj.length) | 0
    var buf = createBuffer(len)

    if (buf.length === 0) {
      return buf
    }

    obj.copy(buf, 0, 0, len)
    return buf
  }

  if (obj.length !== undefined) {
    if (typeof obj.length !== 'number' || numberIsNaN(obj.length)) {
      return createBuffer(0)
    }
    return fromArrayLike(obj)
  }

  if (obj.type === 'Buffer' && Array.isArray(obj.data)) {
    return fromArrayLike(obj.data)
  }
}

function checked (length) {
  // Note: cannot use `length < K_MAX_LENGTH` here because that fails when
  // length is NaN (which is otherwise coerced to zero.)
  if (length >= K_MAX_LENGTH) {
    throw new RangeError('Attempt to allocate Buffer larger than maximum ' +
                         'size: 0x' + K_MAX_LENGTH.toString(16) + ' bytes')
  }
  return length | 0
}

function SlowBuffer (length) {
  if (+length != length) { // eslint-disable-line eqeqeq
    length = 0
  }
  return Buffer.alloc(+length)
}

Buffer.isBuffer = function isBuffer (b) {
  return b != null && b._isBuffer === true &&
    b !== Buffer.prototype // so Buffer.isBuffer(Buffer.prototype) will be false
}

Buffer.compare = function compare (a, b) {
  if (isInstance(a, Uint8Array)) a = Buffer.from(a, a.offset, a.byteLength)
  if (isInstance(b, Uint8Array)) b = Buffer.from(b, b.offset, b.byteLength)
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b)) {
    throw new TypeError(
      'The "buf1", "buf2" arguments must be one of type Buffer or Uint8Array'
    )
  }

  if (a === b) return 0

  var x = a.length
  var y = b.length

  for (var i = 0, len = Math.min(x, y); i < len; ++i) {
    if (a[i] !== b[i]) {
      x = a[i]
      y = b[i]
      break
    }
  }

  if (x < y) return -1
  if (y < x) return 1
  return 0
}

Buffer.isEncoding = function isEncoding (encoding) {
  switch (String(encoding).toLowerCase()) {
    case 'hex':
    case 'utf8':
    case 'utf-8':
    case 'ascii':
    case 'latin1':
    case 'binary':
    case 'base64':
    case 'ucs2':
    case 'ucs-2':
    case 'utf16le':
    case 'utf-16le':
      return true
    default:
      return false
  }
}

Buffer.concat = function concat (list, length) {
  if (!Array.isArray(list)) {
    throw new TypeError('"list" argument must be an Array of Buffers')
  }

  if (list.length === 0) {
    return Buffer.alloc(0)
  }

  var i
  if (length === undefined) {
    length = 0
    for (i = 0; i < list.length; ++i) {
      length += list[i].length
    }
  }

  var buffer = Buffer.allocUnsafe(length)
  var pos = 0
  for (i = 0; i < list.length; ++i) {
    var buf = list[i]
    if (isInstance(buf, Uint8Array)) {
      buf = Buffer.from(buf)
    }
    if (!Buffer.isBuffer(buf)) {
      throw new TypeError('"list" argument must be an Array of Buffers')
    }
    buf.copy(buffer, pos)
    pos += buf.length
  }
  return buffer
}

function byteLength (string, encoding) {
  if (Buffer.isBuffer(string)) {
    return string.length
  }
  if (ArrayBuffer.isView(string) || isInstance(string, ArrayBuffer)) {
    return string.byteLength
  }
  if (typeof string !== 'string') {
    throw new TypeError(
      'The "string" argument must be one of type string, Buffer, or ArrayBuffer. ' +
      'Received type ' + typeof string
    )
  }

  var len = string.length
  var mustMatch = (arguments.length > 2 && arguments[2] === true)
  if (!mustMatch && len === 0) return 0

  // Use a for loop to avoid recursion
  var loweredCase = false
  for (;;) {
    switch (encoding) {
      case 'ascii':
      case 'latin1':
      case 'binary':
        return len
      case 'utf8':
      case 'utf-8':
        return utf8ToBytes(string).length
      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return len * 2
      case 'hex':
        return len >>> 1
      case 'base64':
        return base64ToBytes(string).length
      default:
        if (loweredCase) {
          return mustMatch ? -1 : utf8ToBytes(string).length // assume utf8
        }
        encoding = ('' + encoding).toLowerCase()
        loweredCase = true
    }
  }
}
Buffer.byteLength = byteLength

function slowToString (encoding, start, end) {
  var loweredCase = false

  // No need to verify that "this.length <= MAX_UINT32" since it's a read-only
  // property of a typed array.

  // This behaves neither like String nor Uint8Array in that we set start/end
  // to their upper/lower bounds if the value passed is out of range.
  // undefined is handled specially as per ECMA-262 6th Edition,
  // Section 13.3.3.7 Runtime Semantics: KeyedBindingInitialization.
  if (start === undefined || start < 0) {
    start = 0
  }
  // Return early if start > this.length. Done here to prevent potential uint32
  // coercion fail below.
  if (start > this.length) {
    return ''
  }

  if (end === undefined || end > this.length) {
    end = this.length
  }

  if (end <= 0) {
    return ''
  }

  // Force coersion to uint32. This will also coerce falsey/NaN values to 0.
  end >>>= 0
  start >>>= 0

  if (end <= start) {
    return ''
  }

  if (!encoding) encoding = 'utf8'

  while (true) {
    switch (encoding) {
      case 'hex':
        return hexSlice(this, start, end)

      case 'utf8':
      case 'utf-8':
        return utf8Slice(this, start, end)

      case 'ascii':
        return asciiSlice(this, start, end)

      case 'latin1':
      case 'binary':
        return latin1Slice(this, start, end)

      case 'base64':
        return base64Slice(this, start, end)

      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return utf16leSlice(this, start, end)

      default:
        if (loweredCase) throw new TypeError('Unknown encoding: ' + encoding)
        encoding = (encoding + '').toLowerCase()
        loweredCase = true
    }
  }
}

// This property is used by `Buffer.isBuffer` (and the `is-buffer` npm package)
// to detect a Buffer instance. It's not possible to use `instanceof Buffer`
// reliably in a browserify context because there could be multiple different
// copies of the 'buffer' package in use. This method works even for Buffer
// instances that were created from another copy of the `buffer` package.
// See: https://github.com/feross/buffer/issues/154
Buffer.prototype._isBuffer = true

function swap (b, n, m) {
  var i = b[n]
  b[n] = b[m]
  b[m] = i
}

Buffer.prototype.swap16 = function swap16 () {
  var len = this.length
  if (len % 2 !== 0) {
    throw new RangeError('Buffer size must be a multiple of 16-bits')
  }
  for (var i = 0; i < len; i += 2) {
    swap(this, i, i + 1)
  }
  return this
}

Buffer.prototype.swap32 = function swap32 () {
  var len = this.length
  if (len % 4 !== 0) {
    throw new RangeError('Buffer size must be a multiple of 32-bits')
  }
  for (var i = 0; i < len; i += 4) {
    swap(this, i, i + 3)
    swap(this, i + 1, i + 2)
  }
  return this
}

Buffer.prototype.swap64 = function swap64 () {
  var len = this.length
  if (len % 8 !== 0) {
    throw new RangeError('Buffer size must be a multiple of 64-bits')
  }
  for (var i = 0; i < len; i += 8) {
    swap(this, i, i + 7)
    swap(this, i + 1, i + 6)
    swap(this, i + 2, i + 5)
    swap(this, i + 3, i + 4)
  }
  return this
}

Buffer.prototype.toString = function toString () {
  var length = this.length
  if (length === 0) return ''
  if (arguments.length === 0) return utf8Slice(this, 0, length)
  return slowToString.apply(this, arguments)
}

Buffer.prototype.toLocaleString = Buffer.prototype.toString

Buffer.prototype.equals = function equals (b) {
  if (!Buffer.isBuffer(b)) throw new TypeError('Argument must be a Buffer')
  if (this === b) return true
  return Buffer.compare(this, b) === 0
}

Buffer.prototype.inspect = function inspect () {
  var str = ''
  var max = exports.INSPECT_MAX_BYTES
  str = this.toString('hex', 0, max).replace(/(.{2})/g, '$1 ').trim()
  if (this.length > max) str += ' ... '
  return '<Buffer ' + str + '>'
}

Buffer.prototype.compare = function compare (target, start, end, thisStart, thisEnd) {
  if (isInstance(target, Uint8Array)) {
    target = Buffer.from(target, target.offset, target.byteLength)
  }
  if (!Buffer.isBuffer(target)) {
    throw new TypeError(
      'The "target" argument must be one of type Buffer or Uint8Array. ' +
      'Received type ' + (typeof target)
    )
  }

  if (start === undefined) {
    start = 0
  }
  if (end === undefined) {
    end = target ? target.length : 0
  }
  if (thisStart === undefined) {
    thisStart = 0
  }
  if (thisEnd === undefined) {
    thisEnd = this.length
  }

  if (start < 0 || end > target.length || thisStart < 0 || thisEnd > this.length) {
    throw new RangeError('out of range index')
  }

  if (thisStart >= thisEnd && start >= end) {
    return 0
  }
  if (thisStart >= thisEnd) {
    return -1
  }
  if (start >= end) {
    return 1
  }

  start >>>= 0
  end >>>= 0
  thisStart >>>= 0
  thisEnd >>>= 0

  if (this === target) return 0

  var x = thisEnd - thisStart
  var y = end - start
  var len = Math.min(x, y)

  var thisCopy = this.slice(thisStart, thisEnd)
  var targetCopy = target.slice(start, end)

  for (var i = 0; i < len; ++i) {
    if (thisCopy[i] !== targetCopy[i]) {
      x = thisCopy[i]
      y = targetCopy[i]
      break
    }
  }

  if (x < y) return -1
  if (y < x) return 1
  return 0
}

// Finds either the first index of `val` in `buffer` at offset >= `byteOffset`,
// OR the last index of `val` in `buffer` at offset <= `byteOffset`.
//
// Arguments:
// - buffer - a Buffer to search
// - val - a string, Buffer, or number
// - byteOffset - an index into `buffer`; will be clamped to an int32
// - encoding - an optional encoding, relevant is val is a string
// - dir - true for indexOf, false for lastIndexOf
function bidirectionalIndexOf (buffer, val, byteOffset, encoding, dir) {
  // Empty buffer means no match
  if (buffer.length === 0) return -1

  // Normalize byteOffset
  if (typeof byteOffset === 'string') {
    encoding = byteOffset
    byteOffset = 0
  } else if (byteOffset > 0x7fffffff) {
    byteOffset = 0x7fffffff
  } else if (byteOffset < -0x80000000) {
    byteOffset = -0x80000000
  }
  byteOffset = +byteOffset // Coerce to Number.
  if (numberIsNaN(byteOffset)) {
    // byteOffset: it it's undefined, null, NaN, "foo", etc, search whole buffer
    byteOffset = dir ? 0 : (buffer.length - 1)
  }

  // Normalize byteOffset: negative offsets start from the end of the buffer
  if (byteOffset < 0) byteOffset = buffer.length + byteOffset
  if (byteOffset >= buffer.length) {
    if (dir) return -1
    else byteOffset = buffer.length - 1
  } else if (byteOffset < 0) {
    if (dir) byteOffset = 0
    else return -1
  }

  // Normalize val
  if (typeof val === 'string') {
    val = Buffer.from(val, encoding)
  }

  // Finally, search either indexOf (if dir is true) or lastIndexOf
  if (Buffer.isBuffer(val)) {
    // Special case: looking for empty string/buffer always fails
    if (val.length === 0) {
      return -1
    }
    return arrayIndexOf(buffer, val, byteOffset, encoding, dir)
  } else if (typeof val === 'number') {
    val = val & 0xFF // Search for a byte value [0-255]
    if (typeof Uint8Array.prototype.indexOf === 'function') {
      if (dir) {
        return Uint8Array.prototype.indexOf.call(buffer, val, byteOffset)
      } else {
        return Uint8Array.prototype.lastIndexOf.call(buffer, val, byteOffset)
      }
    }
    return arrayIndexOf(buffer, [ val ], byteOffset, encoding, dir)
  }

  throw new TypeError('val must be string, number or Buffer')
}

function arrayIndexOf (arr, val, byteOffset, encoding, dir) {
  var indexSize = 1
  var arrLength = arr.length
  var valLength = val.length

  if (encoding !== undefined) {
    encoding = String(encoding).toLowerCase()
    if (encoding === 'ucs2' || encoding === 'ucs-2' ||
        encoding === 'utf16le' || encoding === 'utf-16le') {
      if (arr.length < 2 || val.length < 2) {
        return -1
      }
      indexSize = 2
      arrLength /= 2
      valLength /= 2
      byteOffset /= 2
    }
  }

  function read (buf, i) {
    if (indexSize === 1) {
      return buf[i]
    } else {
      return buf.readUInt16BE(i * indexSize)
    }
  }

  var i
  if (dir) {
    var foundIndex = -1
    for (i = byteOffset; i < arrLength; i++) {
      if (read(arr, i) === read(val, foundIndex === -1 ? 0 : i - foundIndex)) {
        if (foundIndex === -1) foundIndex = i
        if (i - foundIndex + 1 === valLength) return foundIndex * indexSize
      } else {
        if (foundIndex !== -1) i -= i - foundIndex
        foundIndex = -1
      }
    }
  } else {
    if (byteOffset + valLength > arrLength) byteOffset = arrLength - valLength
    for (i = byteOffset; i >= 0; i--) {
      var found = true
      for (var j = 0; j < valLength; j++) {
        if (read(arr, i + j) !== read(val, j)) {
          found = false
          break
        }
      }
      if (found) return i
    }
  }

  return -1
}

Buffer.prototype.includes = function includes (val, byteOffset, encoding) {
  return this.indexOf(val, byteOffset, encoding) !== -1
}

Buffer.prototype.indexOf = function indexOf (val, byteOffset, encoding) {
  return bidirectionalIndexOf(this, val, byteOffset, encoding, true)
}

Buffer.prototype.lastIndexOf = function lastIndexOf (val, byteOffset, encoding) {
  return bidirectionalIndexOf(this, val, byteOffset, encoding, false)
}

function hexWrite (buf, string, offset, length) {
  offset = Number(offset) || 0
  var remaining = buf.length - offset
  if (!length) {
    length = remaining
  } else {
    length = Number(length)
    if (length > remaining) {
      length = remaining
    }
  }

  var strLen = string.length

  if (length > strLen / 2) {
    length = strLen / 2
  }
  for (var i = 0; i < length; ++i) {
    var parsed = parseInt(string.substr(i * 2, 2), 16)
    if (numberIsNaN(parsed)) return i
    buf[offset + i] = parsed
  }
  return i
}

function utf8Write (buf, string, offset, length) {
  return blitBuffer(utf8ToBytes(string, buf.length - offset), buf, offset, length)
}

function asciiWrite (buf, string, offset, length) {
  return blitBuffer(asciiToBytes(string), buf, offset, length)
}

function latin1Write (buf, string, offset, length) {
  return asciiWrite(buf, string, offset, length)
}

function base64Write (buf, string, offset, length) {
  return blitBuffer(base64ToBytes(string), buf, offset, length)
}

function ucs2Write (buf, string, offset, length) {
  return blitBuffer(utf16leToBytes(string, buf.length - offset), buf, offset, length)
}

Buffer.prototype.write = function write (string, offset, length, encoding) {
  // Buffer#write(string)
  if (offset === undefined) {
    encoding = 'utf8'
    length = this.length
    offset = 0
  // Buffer#write(string, encoding)
  } else if (length === undefined && typeof offset === 'string') {
    encoding = offset
    length = this.length
    offset = 0
  // Buffer#write(string, offset[, length][, encoding])
  } else if (isFinite(offset)) {
    offset = offset >>> 0
    if (isFinite(length)) {
      length = length >>> 0
      if (encoding === undefined) encoding = 'utf8'
    } else {
      encoding = length
      length = undefined
    }
  } else {
    throw new Error(
      'Buffer.write(string, encoding, offset[, length]) is no longer supported'
    )
  }

  var remaining = this.length - offset
  if (length === undefined || length > remaining) length = remaining

  if ((string.length > 0 && (length < 0 || offset < 0)) || offset > this.length) {
    throw new RangeError('Attempt to write outside buffer bounds')
  }

  if (!encoding) encoding = 'utf8'

  var loweredCase = false
  for (;;) {
    switch (encoding) {
      case 'hex':
        return hexWrite(this, string, offset, length)

      case 'utf8':
      case 'utf-8':
        return utf8Write(this, string, offset, length)

      case 'ascii':
        return asciiWrite(this, string, offset, length)

      case 'latin1':
      case 'binary':
        return latin1Write(this, string, offset, length)

      case 'base64':
        // Warning: maxLength not taken into account in base64Write
        return base64Write(this, string, offset, length)

      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return ucs2Write(this, string, offset, length)

      default:
        if (loweredCase) throw new TypeError('Unknown encoding: ' + encoding)
        encoding = ('' + encoding).toLowerCase()
        loweredCase = true
    }
  }
}

Buffer.prototype.toJSON = function toJSON () {
  return {
    type: 'Buffer',
    data: Array.prototype.slice.call(this._arr || this, 0)
  }
}

function base64Slice (buf, start, end) {
  if (start === 0 && end === buf.length) {
    return base64.fromByteArray(buf)
  } else {
    return base64.fromByteArray(buf.slice(start, end))
  }
}

function utf8Slice (buf, start, end) {
  end = Math.min(buf.length, end)
  var res = []

  var i = start
  while (i < end) {
    var firstByte = buf[i]
    var codePoint = null
    var bytesPerSequence = (firstByte > 0xEF) ? 4
      : (firstByte > 0xDF) ? 3
        : (firstByte > 0xBF) ? 2
          : 1

    if (i + bytesPerSequence <= end) {
      var secondByte, thirdByte, fourthByte, tempCodePoint

      switch (bytesPerSequence) {
        case 1:
          if (firstByte < 0x80) {
            codePoint = firstByte
          }
          break
        case 2:
          secondByte = buf[i + 1]
          if ((secondByte & 0xC0) === 0x80) {
            tempCodePoint = (firstByte & 0x1F) << 0x6 | (secondByte & 0x3F)
            if (tempCodePoint > 0x7F) {
              codePoint = tempCodePoint
            }
          }
          break
        case 3:
          secondByte = buf[i + 1]
          thirdByte = buf[i + 2]
          if ((secondByte & 0xC0) === 0x80 && (thirdByte & 0xC0) === 0x80) {
            tempCodePoint = (firstByte & 0xF) << 0xC | (secondByte & 0x3F) << 0x6 | (thirdByte & 0x3F)
            if (tempCodePoint > 0x7FF && (tempCodePoint < 0xD800 || tempCodePoint > 0xDFFF)) {
              codePoint = tempCodePoint
            }
          }
          break
        case 4:
          secondByte = buf[i + 1]
          thirdByte = buf[i + 2]
          fourthByte = buf[i + 3]
          if ((secondByte & 0xC0) === 0x80 && (thirdByte & 0xC0) === 0x80 && (fourthByte & 0xC0) === 0x80) {
            tempCodePoint = (firstByte & 0xF) << 0x12 | (secondByte & 0x3F) << 0xC | (thirdByte & 0x3F) << 0x6 | (fourthByte & 0x3F)
            if (tempCodePoint > 0xFFFF && tempCodePoint < 0x110000) {
              codePoint = tempCodePoint
            }
          }
      }
    }

    if (codePoint === null) {
      // we did not generate a valid codePoint so insert a
      // replacement char (U+FFFD) and advance only 1 byte
      codePoint = 0xFFFD
      bytesPerSequence = 1
    } else if (codePoint > 0xFFFF) {
      // encode to utf16 (surrogate pair dance)
      codePoint -= 0x10000
      res.push(codePoint >>> 10 & 0x3FF | 0xD800)
      codePoint = 0xDC00 | codePoint & 0x3FF
    }

    res.push(codePoint)
    i += bytesPerSequence
  }

  return decodeCodePointsArray(res)
}

// Based on http://stackoverflow.com/a/22747272/680742, the browser with
// the lowest limit is Chrome, with 0x10000 args.
// We go 1 magnitude less, for safety
var MAX_ARGUMENTS_LENGTH = 0x1000

function decodeCodePointsArray (codePoints) {
  var len = codePoints.length
  if (len <= MAX_ARGUMENTS_LENGTH) {
    return String.fromCharCode.apply(String, codePoints) // avoid extra slice()
  }

  // Decode in chunks to avoid "call stack size exceeded".
  var res = ''
  var i = 0
  while (i < len) {
    res += String.fromCharCode.apply(
      String,
      codePoints.slice(i, i += MAX_ARGUMENTS_LENGTH)
    )
  }
  return res
}

function asciiSlice (buf, start, end) {
  var ret = ''
  end = Math.min(buf.length, end)

  for (var i = start; i < end; ++i) {
    ret += String.fromCharCode(buf[i] & 0x7F)
  }
  return ret
}

function latin1Slice (buf, start, end) {
  var ret = ''
  end = Math.min(buf.length, end)

  for (var i = start; i < end; ++i) {
    ret += String.fromCharCode(buf[i])
  }
  return ret
}

function hexSlice (buf, start, end) {
  var len = buf.length

  if (!start || start < 0) start = 0
  if (!end || end < 0 || end > len) end = len

  var out = ''
  for (var i = start; i < end; ++i) {
    out += toHex(buf[i])
  }
  return out
}

function utf16leSlice (buf, start, end) {
  var bytes = buf.slice(start, end)
  var res = ''
  for (var i = 0; i < bytes.length; i += 2) {
    res += String.fromCharCode(bytes[i] + (bytes[i + 1] * 256))
  }
  return res
}

Buffer.prototype.slice = function slice (start, end) {
  var len = this.length
  start = ~~start
  end = end === undefined ? len : ~~end

  if (start < 0) {
    start += len
    if (start < 0) start = 0
  } else if (start > len) {
    start = len
  }

  if (end < 0) {
    end += len
    if (end < 0) end = 0
  } else if (end > len) {
    end = len
  }

  if (end < start) end = start

  var newBuf = this.subarray(start, end)
  // Return an augmented `Uint8Array` instance
  newBuf.__proto__ = Buffer.prototype
  return newBuf
}

/*
 * Need to make sure that buffer isn't trying to write out of bounds.
 */
function checkOffset (offset, ext, length) {
  if ((offset % 1) !== 0 || offset < 0) throw new RangeError('offset is not uint')
  if (offset + ext > length) throw new RangeError('Trying to access beyond buffer length')
}

Buffer.prototype.readUIntLE = function readUIntLE (offset, byteLength, noAssert) {
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) checkOffset(offset, byteLength, this.length)

  var val = this[offset]
  var mul = 1
  var i = 0
  while (++i < byteLength && (mul *= 0x100)) {
    val += this[offset + i] * mul
  }

  return val
}

Buffer.prototype.readUIntBE = function readUIntBE (offset, byteLength, noAssert) {
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) {
    checkOffset(offset, byteLength, this.length)
  }

  var val = this[offset + --byteLength]
  var mul = 1
  while (byteLength > 0 && (mul *= 0x100)) {
    val += this[offset + --byteLength] * mul
  }

  return val
}

Buffer.prototype.readUInt8 = function readUInt8 (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 1, this.length)
  return this[offset]
}

Buffer.prototype.readUInt16LE = function readUInt16LE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 2, this.length)
  return this[offset] | (this[offset + 1] << 8)
}

Buffer.prototype.readUInt16BE = function readUInt16BE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 2, this.length)
  return (this[offset] << 8) | this[offset + 1]
}

Buffer.prototype.readUInt32LE = function readUInt32LE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)

  return ((this[offset]) |
      (this[offset + 1] << 8) |
      (this[offset + 2] << 16)) +
      (this[offset + 3] * 0x1000000)
}

Buffer.prototype.readUInt32BE = function readUInt32BE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)

  return (this[offset] * 0x1000000) +
    ((this[offset + 1] << 16) |
    (this[offset + 2] << 8) |
    this[offset + 3])
}

Buffer.prototype.readIntLE = function readIntLE (offset, byteLength, noAssert) {
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) checkOffset(offset, byteLength, this.length)

  var val = this[offset]
  var mul = 1
  var i = 0
  while (++i < byteLength && (mul *= 0x100)) {
    val += this[offset + i] * mul
  }
  mul *= 0x80

  if (val >= mul) val -= Math.pow(2, 8 * byteLength)

  return val
}

Buffer.prototype.readIntBE = function readIntBE (offset, byteLength, noAssert) {
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) checkOffset(offset, byteLength, this.length)

  var i = byteLength
  var mul = 1
  var val = this[offset + --i]
  while (i > 0 && (mul *= 0x100)) {
    val += this[offset + --i] * mul
  }
  mul *= 0x80

  if (val >= mul) val -= Math.pow(2, 8 * byteLength)

  return val
}

Buffer.prototype.readInt8 = function readInt8 (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 1, this.length)
  if (!(this[offset] & 0x80)) return (this[offset])
  return ((0xff - this[offset] + 1) * -1)
}

Buffer.prototype.readInt16LE = function readInt16LE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 2, this.length)
  var val = this[offset] | (this[offset + 1] << 8)
  return (val & 0x8000) ? val | 0xFFFF0000 : val
}

Buffer.prototype.readInt16BE = function readInt16BE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 2, this.length)
  var val = this[offset + 1] | (this[offset] << 8)
  return (val & 0x8000) ? val | 0xFFFF0000 : val
}

Buffer.prototype.readInt32LE = function readInt32LE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)

  return (this[offset]) |
    (this[offset + 1] << 8) |
    (this[offset + 2] << 16) |
    (this[offset + 3] << 24)
}

Buffer.prototype.readInt32BE = function readInt32BE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)

  return (this[offset] << 24) |
    (this[offset + 1] << 16) |
    (this[offset + 2] << 8) |
    (this[offset + 3])
}

Buffer.prototype.readFloatLE = function readFloatLE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)
  return ieee754.read(this, offset, true, 23, 4)
}

Buffer.prototype.readFloatBE = function readFloatBE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)
  return ieee754.read(this, offset, false, 23, 4)
}

Buffer.prototype.readDoubleLE = function readDoubleLE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 8, this.length)
  return ieee754.read(this, offset, true, 52, 8)
}

Buffer.prototype.readDoubleBE = function readDoubleBE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 8, this.length)
  return ieee754.read(this, offset, false, 52, 8)
}

function checkInt (buf, value, offset, ext, max, min) {
  if (!Buffer.isBuffer(buf)) throw new TypeError('"buffer" argument must be a Buffer instance')
  if (value > max || value < min) throw new RangeError('"value" argument is out of bounds')
  if (offset + ext > buf.length) throw new RangeError('Index out of range')
}

Buffer.prototype.writeUIntLE = function writeUIntLE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) {
    var maxBytes = Math.pow(2, 8 * byteLength) - 1
    checkInt(this, value, offset, byteLength, maxBytes, 0)
  }

  var mul = 1
  var i = 0
  this[offset] = value & 0xFF
  while (++i < byteLength && (mul *= 0x100)) {
    this[offset + i] = (value / mul) & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeUIntBE = function writeUIntBE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) {
    var maxBytes = Math.pow(2, 8 * byteLength) - 1
    checkInt(this, value, offset, byteLength, maxBytes, 0)
  }

  var i = byteLength - 1
  var mul = 1
  this[offset + i] = value & 0xFF
  while (--i >= 0 && (mul *= 0x100)) {
    this[offset + i] = (value / mul) & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeUInt8 = function writeUInt8 (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 1, 0xff, 0)
  this[offset] = (value & 0xff)
  return offset + 1
}

Buffer.prototype.writeUInt16LE = function writeUInt16LE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 2, 0xffff, 0)
  this[offset] = (value & 0xff)
  this[offset + 1] = (value >>> 8)
  return offset + 2
}

Buffer.prototype.writeUInt16BE = function writeUInt16BE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 2, 0xffff, 0)
  this[offset] = (value >>> 8)
  this[offset + 1] = (value & 0xff)
  return offset + 2
}

Buffer.prototype.writeUInt32LE = function writeUInt32LE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 4, 0xffffffff, 0)
  this[offset + 3] = (value >>> 24)
  this[offset + 2] = (value >>> 16)
  this[offset + 1] = (value >>> 8)
  this[offset] = (value & 0xff)
  return offset + 4
}

Buffer.prototype.writeUInt32BE = function writeUInt32BE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 4, 0xffffffff, 0)
  this[offset] = (value >>> 24)
  this[offset + 1] = (value >>> 16)
  this[offset + 2] = (value >>> 8)
  this[offset + 3] = (value & 0xff)
  return offset + 4
}

Buffer.prototype.writeIntLE = function writeIntLE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) {
    var limit = Math.pow(2, (8 * byteLength) - 1)

    checkInt(this, value, offset, byteLength, limit - 1, -limit)
  }

  var i = 0
  var mul = 1
  var sub = 0
  this[offset] = value & 0xFF
  while (++i < byteLength && (mul *= 0x100)) {
    if (value < 0 && sub === 0 && this[offset + i - 1] !== 0) {
      sub = 1
    }
    this[offset + i] = ((value / mul) >> 0) - sub & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeIntBE = function writeIntBE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) {
    var limit = Math.pow(2, (8 * byteLength) - 1)

    checkInt(this, value, offset, byteLength, limit - 1, -limit)
  }

  var i = byteLength - 1
  var mul = 1
  var sub = 0
  this[offset + i] = value & 0xFF
  while (--i >= 0 && (mul *= 0x100)) {
    if (value < 0 && sub === 0 && this[offset + i + 1] !== 0) {
      sub = 1
    }
    this[offset + i] = ((value / mul) >> 0) - sub & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeInt8 = function writeInt8 (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 1, 0x7f, -0x80)
  if (value < 0) value = 0xff + value + 1
  this[offset] = (value & 0xff)
  return offset + 1
}

Buffer.prototype.writeInt16LE = function writeInt16LE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 2, 0x7fff, -0x8000)
  this[offset] = (value & 0xff)
  this[offset + 1] = (value >>> 8)
  return offset + 2
}

Buffer.prototype.writeInt16BE = function writeInt16BE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 2, 0x7fff, -0x8000)
  this[offset] = (value >>> 8)
  this[offset + 1] = (value & 0xff)
  return offset + 2
}

Buffer.prototype.writeInt32LE = function writeInt32LE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 4, 0x7fffffff, -0x80000000)
  this[offset] = (value & 0xff)
  this[offset + 1] = (value >>> 8)
  this[offset + 2] = (value >>> 16)
  this[offset + 3] = (value >>> 24)
  return offset + 4
}

Buffer.prototype.writeInt32BE = function writeInt32BE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 4, 0x7fffffff, -0x80000000)
  if (value < 0) value = 0xffffffff + value + 1
  this[offset] = (value >>> 24)
  this[offset + 1] = (value >>> 16)
  this[offset + 2] = (value >>> 8)
  this[offset + 3] = (value & 0xff)
  return offset + 4
}

function checkIEEE754 (buf, value, offset, ext, max, min) {
  if (offset + ext > buf.length) throw new RangeError('Index out of range')
  if (offset < 0) throw new RangeError('Index out of range')
}

function writeFloat (buf, value, offset, littleEndian, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) {
    checkIEEE754(buf, value, offset, 4, 3.4028234663852886e+38, -3.4028234663852886e+38)
  }
  ieee754.write(buf, value, offset, littleEndian, 23, 4)
  return offset + 4
}

Buffer.prototype.writeFloatLE = function writeFloatLE (value, offset, noAssert) {
  return writeFloat(this, value, offset, true, noAssert)
}

Buffer.prototype.writeFloatBE = function writeFloatBE (value, offset, noAssert) {
  return writeFloat(this, value, offset, false, noAssert)
}

function writeDouble (buf, value, offset, littleEndian, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) {
    checkIEEE754(buf, value, offset, 8, 1.7976931348623157E+308, -1.7976931348623157E+308)
  }
  ieee754.write(buf, value, offset, littleEndian, 52, 8)
  return offset + 8
}

Buffer.prototype.writeDoubleLE = function writeDoubleLE (value, offset, noAssert) {
  return writeDouble(this, value, offset, true, noAssert)
}

Buffer.prototype.writeDoubleBE = function writeDoubleBE (value, offset, noAssert) {
  return writeDouble(this, value, offset, false, noAssert)
}

// copy(targetBuffer, targetStart=0, sourceStart=0, sourceEnd=buffer.length)
Buffer.prototype.copy = function copy (target, targetStart, start, end) {
  if (!Buffer.isBuffer(target)) throw new TypeError('argument should be a Buffer')
  if (!start) start = 0
  if (!end && end !== 0) end = this.length
  if (targetStart >= target.length) targetStart = target.length
  if (!targetStart) targetStart = 0
  if (end > 0 && end < start) end = start

  // Copy 0 bytes; we're done
  if (end === start) return 0
  if (target.length === 0 || this.length === 0) return 0

  // Fatal error conditions
  if (targetStart < 0) {
    throw new RangeError('targetStart out of bounds')
  }
  if (start < 0 || start >= this.length) throw new RangeError('Index out of range')
  if (end < 0) throw new RangeError('sourceEnd out of bounds')

  // Are we oob?
  if (end > this.length) end = this.length
  if (target.length - targetStart < end - start) {
    end = target.length - targetStart + start
  }

  var len = end - start

  if (this === target && typeof Uint8Array.prototype.copyWithin === 'function') {
    // Use built-in when available, missing from IE11
    this.copyWithin(targetStart, start, end)
  } else if (this === target && start < targetStart && targetStart < end) {
    // descending copy from end
    for (var i = len - 1; i >= 0; --i) {
      target[i + targetStart] = this[i + start]
    }
  } else {
    Uint8Array.prototype.set.call(
      target,
      this.subarray(start, end),
      targetStart
    )
  }

  return len
}

// Usage:
//    buffer.fill(number[, offset[, end]])
//    buffer.fill(buffer[, offset[, end]])
//    buffer.fill(string[, offset[, end]][, encoding])
Buffer.prototype.fill = function fill (val, start, end, encoding) {
  // Handle string cases:
  if (typeof val === 'string') {
    if (typeof start === 'string') {
      encoding = start
      start = 0
      end = this.length
    } else if (typeof end === 'string') {
      encoding = end
      end = this.length
    }
    if (encoding !== undefined && typeof encoding !== 'string') {
      throw new TypeError('encoding must be a string')
    }
    if (typeof encoding === 'string' && !Buffer.isEncoding(encoding)) {
      throw new TypeError('Unknown encoding: ' + encoding)
    }
    if (val.length === 1) {
      var code = val.charCodeAt(0)
      if ((encoding === 'utf8' && code < 128) ||
          encoding === 'latin1') {
        // Fast path: If `val` fits into a single byte, use that numeric value.
        val = code
      }
    }
  } else if (typeof val === 'number') {
    val = val & 255
  }

  // Invalid ranges are not set to a default, so can range check early.
  if (start < 0 || this.length < start || this.length < end) {
    throw new RangeError('Out of range index')
  }

  if (end <= start) {
    return this
  }

  start = start >>> 0
  end = end === undefined ? this.length : end >>> 0

  if (!val) val = 0

  var i
  if (typeof val === 'number') {
    for (i = start; i < end; ++i) {
      this[i] = val
    }
  } else {
    var bytes = Buffer.isBuffer(val)
      ? val
      : Buffer.from(val, encoding)
    var len = bytes.length
    if (len === 0) {
      throw new TypeError('The value "' + val +
        '" is invalid for argument "value"')
    }
    for (i = 0; i < end - start; ++i) {
      this[i + start] = bytes[i % len]
    }
  }

  return this
}

// HELPER FUNCTIONS
// ================

var INVALID_BASE64_RE = /[^+/0-9A-Za-z-_]/g

function base64clean (str) {
  // Node takes equal signs as end of the Base64 encoding
  str = str.split('=')[0]
  // Node strips out invalid characters like \n and \t from the string, base64-js does not
  str = str.trim().replace(INVALID_BASE64_RE, '')
  // Node converts strings with length < 2 to ''
  if (str.length < 2) return ''
  // Node allows for non-padded base64 strings (missing trailing ===), base64-js does not
  while (str.length % 4 !== 0) {
    str = str + '='
  }
  return str
}

function toHex (n) {
  if (n < 16) return '0' + n.toString(16)
  return n.toString(16)
}

function utf8ToBytes (string, units) {
  units = units || Infinity
  var codePoint
  var length = string.length
  var leadSurrogate = null
  var bytes = []

  for (var i = 0; i < length; ++i) {
    codePoint = string.charCodeAt(i)

    // is surrogate component
    if (codePoint > 0xD7FF && codePoint < 0xE000) {
      // last char was a lead
      if (!leadSurrogate) {
        // no lead yet
        if (codePoint > 0xDBFF) {
          // unexpected trail
          if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
          continue
        } else if (i + 1 === length) {
          // unpaired lead
          if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
          continue
        }

        // valid lead
        leadSurrogate = codePoint

        continue
      }

      // 2 leads in a row
      if (codePoint < 0xDC00) {
        if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
        leadSurrogate = codePoint
        continue
      }

      // valid surrogate pair
      codePoint = (leadSurrogate - 0xD800 << 10 | codePoint - 0xDC00) + 0x10000
    } else if (leadSurrogate) {
      // valid bmp char, but last char was a lead
      if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
    }

    leadSurrogate = null

    // encode utf8
    if (codePoint < 0x80) {
      if ((units -= 1) < 0) break
      bytes.push(codePoint)
    } else if (codePoint < 0x800) {
      if ((units -= 2) < 0) break
      bytes.push(
        codePoint >> 0x6 | 0xC0,
        codePoint & 0x3F | 0x80
      )
    } else if (codePoint < 0x10000) {
      if ((units -= 3) < 0) break
      bytes.push(
        codePoint >> 0xC | 0xE0,
        codePoint >> 0x6 & 0x3F | 0x80,
        codePoint & 0x3F | 0x80
      )
    } else if (codePoint < 0x110000) {
      if ((units -= 4) < 0) break
      bytes.push(
        codePoint >> 0x12 | 0xF0,
        codePoint >> 0xC & 0x3F | 0x80,
        codePoint >> 0x6 & 0x3F | 0x80,
        codePoint & 0x3F | 0x80
      )
    } else {
      throw new Error('Invalid code point')
    }
  }

  return bytes
}

function asciiToBytes (str) {
  var byteArray = []
  for (var i = 0; i < str.length; ++i) {
    // Node's code seems to be doing this and not & 0x7F..
    byteArray.push(str.charCodeAt(i) & 0xFF)
  }
  return byteArray
}

function utf16leToBytes (str, units) {
  var c, hi, lo
  var byteArray = []
  for (var i = 0; i < str.length; ++i) {
    if ((units -= 2) < 0) break

    c = str.charCodeAt(i)
    hi = c >> 8
    lo = c % 256
    byteArray.push(lo)
    byteArray.push(hi)
  }

  return byteArray
}

function base64ToBytes (str) {
  return base64.toByteArray(base64clean(str))
}

function blitBuffer (src, dst, offset, length) {
  for (var i = 0; i < length; ++i) {
    if ((i + offset >= dst.length) || (i >= src.length)) break
    dst[i + offset] = src[i]
  }
  return i
}

// ArrayBuffer or Uint8Array objects from other contexts (i.e. iframes) do not pass
// the `instanceof` check but they should be treated as of that type.
// See: https://github.com/feross/buffer/issues/166
function isInstance (obj, type) {
  return obj instanceof type ||
    (obj != null && obj.constructor != null && obj.constructor.name != null &&
      obj.constructor.name === type.name)
}
function numberIsNaN (obj) {
  // For IE11 support
  return obj !== obj // eslint-disable-line no-self-compare
}

}).call(this)}).call(this,require("buffer").Buffer)
},{"base64-js":8,"buffer":9,"ieee754":10}],10:[function(require,module,exports){
/*! ieee754. BSD-3-Clause License. Feross Aboukhadijeh <https://feross.org/opensource> */
exports.read = function (buffer, offset, isLE, mLen, nBytes) {
  var e, m
  var eLen = (nBytes * 8) - mLen - 1
  var eMax = (1 << eLen) - 1
  var eBias = eMax >> 1
  var nBits = -7
  var i = isLE ? (nBytes - 1) : 0
  var d = isLE ? -1 : 1
  var s = buffer[offset + i]

  i += d

  e = s & ((1 << (-nBits)) - 1)
  s >>= (-nBits)
  nBits += eLen
  for (; nBits > 0; e = (e * 256) + buffer[offset + i], i += d, nBits -= 8) {}

  m = e & ((1 << (-nBits)) - 1)
  e >>= (-nBits)
  nBits += mLen
  for (; nBits > 0; m = (m * 256) + buffer[offset + i], i += d, nBits -= 8) {}

  if (e === 0) {
    e = 1 - eBias
  } else if (e === eMax) {
    return m ? NaN : ((s ? -1 : 1) * Infinity)
  } else {
    m = m + Math.pow(2, mLen)
    e = e - eBias
  }
  return (s ? -1 : 1) * m * Math.pow(2, e - mLen)
}

exports.write = function (buffer, value, offset, isLE, mLen, nBytes) {
  var e, m, c
  var eLen = (nBytes * 8) - mLen - 1
  var eMax = (1 << eLen) - 1
  var eBias = eMax >> 1
  var rt = (mLen === 23 ? Math.pow(2, -24) - Math.pow(2, -77) : 0)
  var i = isLE ? 0 : (nBytes - 1)
  var d = isLE ? 1 : -1
  var s = value < 0 || (value === 0 && 1 / value < 0) ? 1 : 0

  value = Math.abs(value)

  if (isNaN(value) || value === Infinity) {
    m = isNaN(value) ? 1 : 0
    e = eMax
  } else {
    e = Math.floor(Math.log(value) / Math.LN2)
    if (value * (c = Math.pow(2, -e)) < 1) {
      e--
      c *= 2
    }
    if (e + eBias >= 1) {
      value += rt / c
    } else {
      value += rt * Math.pow(2, 1 - eBias)
    }
    if (value * c >= 2) {
      e++
      c /= 2
    }

    if (e + eBias >= eMax) {
      m = 0
      e = eMax
    } else if (e + eBias >= 1) {
      m = ((value * c) - 1) * Math.pow(2, mLen)
      e = e + eBias
    } else {
      m = value * Math.pow(2, eBias - 1) * Math.pow(2, mLen)
      e = 0
    }
  }

  for (; mLen >= 8; buffer[offset + i] = m & 0xff, i += d, m /= 256, mLen -= 8) {}

  e = (e << mLen) | m
  eLen += mLen
  for (; eLen > 0; buffer[offset + i] = e & 0xff, i += d, e /= 256, eLen -= 8) {}

  buffer[offset + i - d] |= s * 128
}

},{}],11:[function(require,module,exports){
// shim for using process in browser
var process = module.exports = {};

// cached from whatever global is present so that test runners that stub it
// don't break things.  But we need to wrap it in a try catch in case it is
// wrapped in strict mode code which doesn't define any globals.  It's inside a
// function because try/catches deoptimize in certain engines.

var cachedSetTimeout;
var cachedClearTimeout;

function defaultSetTimout() {
    throw new Error('setTimeout has not been defined');
}
function defaultClearTimeout () {
    throw new Error('clearTimeout has not been defined');
}
(function () {
    try {
        if (typeof setTimeout === 'function') {
            cachedSetTimeout = setTimeout;
        } else {
            cachedSetTimeout = defaultSetTimout;
        }
    } catch (e) {
        cachedSetTimeout = defaultSetTimout;
    }
    try {
        if (typeof clearTimeout === 'function') {
            cachedClearTimeout = clearTimeout;
        } else {
            cachedClearTimeout = defaultClearTimeout;
        }
    } catch (e) {
        cachedClearTimeout = defaultClearTimeout;
    }
} ())
function runTimeout(fun) {
    if (cachedSetTimeout === setTimeout) {
        //normal enviroments in sane situations
        return setTimeout(fun, 0);
    }
    // if setTimeout wasn't available but was latter defined
    if ((cachedSetTimeout === defaultSetTimout || !cachedSetTimeout) && setTimeout) {
        cachedSetTimeout = setTimeout;
        return setTimeout(fun, 0);
    }
    try {
        // when when somebody has screwed with setTimeout but no I.E. maddness
        return cachedSetTimeout(fun, 0);
    } catch(e){
        try {
            // When we are in I.E. but the script has been evaled so I.E. doesn't trust the global object when called normally
            return cachedSetTimeout.call(null, fun, 0);
        } catch(e){
            // same as above but when it's a version of I.E. that must have the global object for 'this', hopfully our context correct otherwise it will throw a global error
            return cachedSetTimeout.call(this, fun, 0);
        }
    }


}
function runClearTimeout(marker) {
    if (cachedClearTimeout === clearTimeout) {
        //normal enviroments in sane situations
        return clearTimeout(marker);
    }
    // if clearTimeout wasn't available but was latter defined
    if ((cachedClearTimeout === defaultClearTimeout || !cachedClearTimeout) && clearTimeout) {
        cachedClearTimeout = clearTimeout;
        return clearTimeout(marker);
    }
    try {
        // when when somebody has screwed with setTimeout but no I.E. maddness
        return cachedClearTimeout(marker);
    } catch (e){
        try {
            // When we are in I.E. but the script has been evaled so I.E. doesn't  trust the global object when called normally
            return cachedClearTimeout.call(null, marker);
        } catch (e){
            // same as above but when it's a version of I.E. that must have the global object for 'this', hopfully our context correct otherwise it will throw a global error.
            // Some versions of I.E. have different rules for clearTimeout vs setTimeout
            return cachedClearTimeout.call(this, marker);
        }
    }



}
var queue = [];
var draining = false;
var currentQueue;
var queueIndex = -1;

function cleanUpNextTick() {
    if (!draining || !currentQueue) {
        return;
    }
    draining = false;
    if (currentQueue.length) {
        queue = currentQueue.concat(queue);
    } else {
        queueIndex = -1;
    }
    if (queue.length) {
        drainQueue();
    }
}

function drainQueue() {
    if (draining) {
        return;
    }
    var timeout = runTimeout(cleanUpNextTick);
    draining = true;

    var len = queue.length;
    while(len) {
        currentQueue = queue;
        queue = [];
        while (++queueIndex < len) {
            if (currentQueue) {
                currentQueue[queueIndex].run();
            }
        }
        queueIndex = -1;
        len = queue.length;
    }
    currentQueue = null;
    draining = false;
    runClearTimeout(timeout);
}

process.nextTick = function (fun) {
    var args = new Array(arguments.length - 1);
    if (arguments.length > 1) {
        for (var i = 1; i < arguments.length; i++) {
            args[i - 1] = arguments[i];
        }
    }
    queue.push(new Item(fun, args));
    if (queue.length === 1 && !draining) {
        runTimeout(drainQueue);
    }
};

// v8 likes predictible objects
function Item(fun, array) {
    this.fun = fun;
    this.array = array;
}
Item.prototype.run = function () {
    this.fun.apply(null, this.array);
};
process.title = 'browser';
process.browser = true;
process.env = {};
process.argv = [];
process.version = ''; // empty string to avoid regexp issues
process.versions = {};

function noop() {}

process.on = noop;
process.addListener = noop;
process.once = noop;
process.off = noop;
process.removeListener = noop;
process.removeAllListeners = noop;
process.emit = noop;
process.prependListener = noop;
process.prependOnceListener = noop;

process.listeners = function (name) { return [] }

process.binding = function (name) {
    throw new Error('process.binding is not supported');
};

process.cwd = function () { return '/' };
process.chdir = function (dir) {
    throw new Error('process.chdir is not supported');
};
process.umask = function() { return 0; };

},{}]},{},[1])(1)
});
