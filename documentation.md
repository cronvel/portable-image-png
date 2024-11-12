
# Portable Image PNG

Lightweight PNG loader/saver written from scratch, supporting RGB/RGBA/Grayscale/Grayscale+Alpha and indexed mode.

Both Node.js and browser environment are supported.

The file is loaded inside a [PortableImage data structure](https://github.com/cronvel/portable-image).

**Note that unlike other PNG libs, the palette and index informations are kept.**
Other libs create a RGB/RGBA buffers for indexed PNG.
It allows easy palette manipulations, and if a RGB/RGBA buffer is wanted, the PortableImage instance can easily convert it to RGB/RGBA.

Also the lib uses the **CompressionStream API** (available both in Node.js and browsers) to avoid zlib dependencies.

For instance the lib does not support Adam7 interlacing mode.
The encoder is straightforward thus does not try to optimize for size.

