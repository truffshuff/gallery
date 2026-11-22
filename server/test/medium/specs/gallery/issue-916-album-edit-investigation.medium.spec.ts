// Investigation only: reproduce #916 against the current server without changing its permission policy.
import { BadRequestException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { AlbumUserRole, SharedSpaceRole } from 'src/enum.js';
import { SpatialSceneRepository } from 'src/gallery/repositories/spatial-scene.repository.js';
import { GalleryAssetService } from 'src/gallery/services/gallery-asset.service.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AlbumUserRepository } from 'src/repositories/album-user.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SharedSpaceRepository } from 'src/repositories/shared-space.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { WebsocketRepository } from 'src/repositories/websocket.repository.js';
import { DB } from 'src/schema/index.js';
import { AssetService } from 'src/services/asset.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

const CASES = [
  { label: 'ordinary shared album', linked: false, role: undefined, uploaderMember: false, editable: false },
  {
    label: 'Space Owner, uploader member',
    linked: true,
    role: SharedSpaceRole.Owner,
    uploaderMember: true,
    editable: true,
  },
  {
    label: 'Space Editor, uploader member',
    linked: true,
    role: SharedSpaceRole.Editor,
    uploaderMember: true,
    editable: true,
  },
  {
    label: 'Space Viewer, uploader member',
    linked: true,
    role: SharedSpaceRole.Viewer,
    uploaderMember: true,
    editable: false,
  },
  { label: 'Space non-member, uploader member', linked: true, role: undefined, uploaderMember: true, editable: false },
  {
    label: 'Space Owner, uploader absent',
    linked: true,
    role: SharedSpaceRole.Owner,
    uploaderMember: false,
    editable: false,
  },
  {
    label: 'Space Editor, uploader absent',
    linked: true,
    role: SharedSpaceRole.Editor,
    uploaderMember: false,
    editable: false,
  },
  {
    label: 'Space Viewer, uploader absent',
    linked: true,
    role: SharedSpaceRole.Viewer,
    uploaderMember: false,
    editable: false,
  },
  { label: 'Space non-member, uploader absent', linked: true, role: undefined, uploaderMember: false, editable: false },
] as const;

const BEFORE = '2020-01-02T03:04:05.000Z';
const AFTER = '2021-06-07T08:09:10.000Z';
const AGAIN = '2022-07-08T09:10:11.000Z';
let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => {
  await db?.destroy();
});

describe.each([false, true])('issue #916, album owner isAdmin=%s', (isAdmin) => {
  it.each(CASES)('$label', async ({ linked, role, uploaderMember, editable }) => {
    const { sut, ctx } = newMediumService(AssetService, {
      database: db,
      real: [
        AccessRepository,
        AlbumRepository,
        AlbumUserRepository,
        AssetRepository,
        ConfigRepository,
        SharedSpaceRepository,
        SpatialSceneRepository,
        SystemMetadataRepository,
        UserRepository,
      ],
      mock: [EventRepository, JobRepository, LoggingRepository, StorageRepository, WebsocketRepository],
    });
    const jobs = ctx.getMock(JobRepository);
    jobs.queue.mockResolvedValue();
    jobs.queueAll.mockResolvedValue();
    ctx.getMock(EventRepository).emit.mockResolvedValue();

    const { user: albumOwner } = await ctx.newUser({ isAdmin });
    const { user: uploader } = await ctx.newUser({ isAdmin: false });
    const { result: album } = await ctx.newAlbum({ ownerId: albumOwner.id });
    await ctx.newAlbumUser({ albumId: album.id, userId: uploader.id, role: AlbumUserRole.Editor });
    const { asset } = await ctx.newAsset({ ownerId: uploader.id });
    await ctx.newExif({ assetId: asset.id, dateTimeOriginal: new Date(BEFORE), timeZone: 'UTC' });
    await ctx.newAlbumAsset({ albumId: album.id, assetId: asset.id });

    if (linked) {
      const { user: host } = await ctx.newUser();
      const { space } = await ctx.newSharedSpace({ createdById: host.id });
      await ctx.newSharedSpaceMember({ spaceId: space.id, userId: host.id, role: SharedSpaceRole.Owner });
      if (role) {
        await ctx.newSharedSpaceMember({ spaceId: space.id, userId: albumOwner.id, role });
      }
      if (uploaderMember) {
        await ctx.newSharedSpaceMember({ spaceId: space.id, userId: uploader.id, role: SharedSpaceRole.Viewer });
      }
      await ctx.newSharedSpaceAlbum({ spaceId: space.id, albumId: album.id });
    }

    const auth = factory.auth({ user: { id: albumOwner.id, isAdmin } });
    const uploaderAuth = factory.auth({ user: { id: uploader.id, isAdmin: false } });
    // The caller can actually read the uploaded photo; a denial must not be explained by an unreachable asset.
    await expect(sut.get(auth, asset.id)).resolves.toMatchObject({
      id: asset.id,
      ownerId: uploader.id,
      canEdit: editable,
    });
    await expect(sut.get(uploaderAuth, asset.id)).resolves.toMatchObject({ canEdit: true });
    await expect(ctx.getService(GalleryAssetService).getEditable(auth, { assetIds: [asset.id] })).resolves.toEqual({
      editableAssetIds: editable ? [asset.id] : [],
    });

    const read = () =>
      db.selectFrom('asset_exif').selectAll().where('assetId', '=', asset.id).executeTakeFirstOrThrow();
    const before = await read();
    if (!editable) {
      await expect(sut.update(auth, asset.id, { dateTimeOriginal: AFTER })).rejects.toBeInstanceOf(BadRequestException);
      expect(await read()).toEqual(before);
      expect(jobs.queue).not.toHaveBeenCalled();
      expect(jobs.queueAll).not.toHaveBeenCalled();
      return;
    }

    // The actual write and its returned detail response must agree with the capability answer.
    await expect(sut.update(auth, asset.id, { dateTimeOriginal: AFTER })).resolves.toMatchObject({ canEdit: true });
    expect((await read()).dateTimeOriginal?.toISOString()).toBe(AFTER);
    await expect(sut.get(auth, asset.id)).resolves.toMatchObject({ canEdit: true });
    await expect(sut.update(auth, asset.id, { dateTimeOriginal: AGAIN })).resolves.toMatchObject({ canEdit: true });
    expect((await read()).dateTimeOriginal?.toISOString()).toBe(AGAIN);
  });
});
