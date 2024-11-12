#!/usr/bin/env node

"use strict" ;

const Png = require( '..' ) ;



// Argument management

if ( process.argv.length < 3 ) {
	console.error( "Expecting a PNG file" ) ;
	process.exit( 1 ) ;
}

var sourceFile = process.argv[ 2 ] ;
var outputFile = process.argv[ 3 ] ?? null ;


async function test() {
	var image = await Png.loadImage( sourceFile , { crc32: true } ) ;

	if ( outputFile ) {
		await Png.saveImage( outputFile , image ) ;
	}
}

test() ;

