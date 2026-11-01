import { getAlbumStack, type StackResponseDto } from '@immich/sdk';
import { page } from '$app/state';
import { albumStackPreferences } from '$lib/gallery/stack/album-stack-preferences.svelte';

/**
 * The album the asset viewer is open in. The album page hands the viewer its album; the space album page does not
 * (that would turn on album activity and cover actions there), so its route's `albumId` stands in.
 */
export const viewerAlbumId = (album?: { id: string }): string | undefined => album?.id ?? page.params.albumId;

/**
 * The ids the stack strip may show, when the "only this album's photos" setting is on inside an album; otherwise
 * `undefined`, the whole stack. A failed lookup also shows the whole stack.
 */
export const loadAlbumStackStripIds = async (stackId: string, albumId: string | undefined) => {
  if (!albumId || !albumStackPreferences.stripInAlbum) {
    return;
  }
  try {
    const { assets } = await getAlbumStack({ id: albumId, stackId });
    return new Set(assets.map(({ id }) => id));
  } catch {
    return;
  }
};

/**
 * What the viewer's stack strip shows: the stack narrowed to `ids`, or none below two photos. The stack itself stays
 * whole, because the stack actions (unstack, keep this and delete others, …) act on every member.
 */
export const stackStrip = (stack: StackResponseDto | undefined, ids: Set<string> | undefined) => {
  if (!stack || !ids) {
    return stack;
  }
  const assets = stack.assets.filter(({ id }) => ids.has(id));
  return assets.length > 1 ? { ...stack, assets } : undefined;
};
