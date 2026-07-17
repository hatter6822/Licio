// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-N compliance console page.  Authorization is enforced server-side; a
// non-reviewer sees an access notice rather than data (WS-N.2.1c-2).
import { ComplianceConsole } from '../../components/compliance/index.js';

export function ComplianceConsolePage(): React.ReactElement {
  return <ComplianceConsole />;
}
