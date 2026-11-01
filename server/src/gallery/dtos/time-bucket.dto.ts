import { stringToBool } from 'src/validation.js';

// Fork time-bucket request fields, merged into upstream's TimeBucketDto in src/dtos/time-bucket.dto.ts with one
// `.extend(...)`. This module must stay a leaf: src/dtos/time-bucket.dto.ts imports it.

export const GalleryTimeBucketExtension = {
  stackCountInAlbum: stringToBool
    .optional()
    .describe(
      "With albumId and withStacked: a stack's count covers only the stack members this album holds. Otherwise it covers the whole stack.",
    ),
};
