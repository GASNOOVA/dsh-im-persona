// Russian translations for host-side user-facing text.
// Keys are the exact Chinese literals passed to t() in src/channels/**.
// This dictionary is a partial overlay: a key missing here is answered from
// ./i18n-en.mjs, never from the Chinese identity key (see t() in ./i18n.mjs).
// Entries are maintained per area in ./i18n-ru/*.mjs and merged here.
// Personal edition: only the Weixin and QQ channel dictionaries remain.

import imageInput from './i18n-ru/image-input.mjs';
import permission from './i18n-ru/permission.mjs';
import diagnostics from './i18n-ru/diagnostics.mjs';

import sharedA from './i18n-ru/shared-a.mjs';
import sharedB from './i18n-ru/shared-b.mjs';
import sharedC from './i18n-ru/shared-c.mjs';
import sharedD from './i18n-ru/shared-d.mjs';
import qq from './i18n-ru/qq.mjs';
import weixin from './i18n-ru/weixin.mjs';
import legacyShared from './i18n-ru/legacy-shared.mjs';

export const RU = Object.freeze(Object.assign(
  {},
  diagnostics,
  imageInput,
  permission,
  sharedA,
  sharedB,
  sharedC,
  sharedD,
  qq,
  weixin,
  legacyShared,
));
