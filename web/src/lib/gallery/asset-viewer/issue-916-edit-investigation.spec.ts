import DetailPanel from '#lib/components/asset-viewer/DetailPanel.svelte';
import { authManager } from '#lib/managers/auth-manager.svelte.ts';
import { factory } from '#test/unit/factories.ts';
import { test } from '#test/unit/fixtures.ts';
import { renderWithTooltips } from '#test/unit/helpers.ts';
import { setPage } from '#test/unit/mocks/app-state.svelte.ts';
import { expect } from 'vitest';
import { page } from 'vitest/browser';

for (const isAdmin of [false, true]) {
  for (const canEdit of [false, true]) {
    for (const pathname of ['/albums/a/photos/photo', '/spaces/s/albums/a/photos/photo']) {
      test(`date editing on ${pathname}: isAdmin=${isAdmin}, server canEdit=${canEdit}`, async ({ data, settle }) => {
        authManager.setUser({ ...data.user, isAdmin });
        authManager.setPreferences(factory.preferences());
        setPage({ url: new URL(pathname, 'http://localhost') });
        const asset = factory.asset({
          id: 'photo',
          ownerId: 'uploader',
          canEdit,
          exifInfo: {
            dateTimeOriginal: '2020-01-02T03:04:05.000Z',
            timeZone: 'UTC',
            latitude: undefined,
            longitude: undefined,
          },
          people: [],
          tags: [],
        });
        const album = factory.album({ id: 'a', ownerId: data.user.id });
        await renderWithTooltips(DetailPanel, { asset, currentAlbum: album });
        await settle();
        if (canEdit) {
          await expect.element(page.getByTestId('detail-panel-edit-date-button')).toBeInTheDocument();
        } else {
          await expect.element(page.getByTestId('detail-panel-edit-date-button')).not.toBeInTheDocument();
        }
      });
    }
  }
}
