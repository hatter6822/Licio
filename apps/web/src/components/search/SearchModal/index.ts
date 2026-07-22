// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Deliberately exports ONLY the lazy host: a static re-export of SearchModal
// here would pull the modal chunk into every importer's bundle and defeat the
// code split (tests import ./SearchModal.js directly).
export { SearchModalHost } from './SearchModalHost.js';
