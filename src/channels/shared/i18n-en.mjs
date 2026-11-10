// English translations for host-side user-facing text.
// Keys are the exact Chinese literals passed to t() in src/channels/**.
// Chinese output is the identity default and needs no entries here.
// Entries are maintained per area in ./i18n-en/*.mjs and merged here.
// Personal edition: only the Weixin and QQ channel dictionaries remain.

import imageInput from './i18n-en/image-input.mjs';
import permission from './i18n-en/permission.mjs';
import diagnostics from './i18n-en/diagnostics.mjs';

import sharedA from './i18n-en/shared-a.mjs';
import sharedB from './i18n-en/shared-b.mjs';
import sharedC from './i18n-en/shared-c.mjs';
import sharedD from './i18n-en/shared-d.mjs';
import qq from './i18n-en/qq.mjs';
import weixin from './i18n-en/weixin.mjs';
import legacyShared from './i18n-en/legacy-shared.mjs';

export const EN = Object.freeze(Object.assign(
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
