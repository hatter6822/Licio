// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-N.1.2b — the German catalog for the disabled-state messages (the
// non-English completeness requirement).  Legally-reviewed, region-specific
// copy: never vaguer than the English source.  Keys follow the
// `disabled.{feature}.{reason}` pattern for translator clarity.
import type { Messages } from '../I18nProvider.js';

const messages: Messages = {
  'disabled.region.unknown': 'Ihre Region',
  'disabled.wallet_connection.title': 'Die Wallet-Verknüpfung ist nicht verfügbar',
  'disabled.testnet_transactions.title': 'Testnetz-Transaktionen sind nicht verfügbar',
  'disabled.production_payments.title': 'Zahlungen sind nicht verfügbar',
  'disabled.treasury_operations.title':
    'Die Beteiligung an der Gemeinschaftskasse ist nicht verfügbar',
  'disabled.governance.title': 'Governance-Signaturen sind nicht verfügbar',
  'disabled.wallet_connection.region_unsupported':
    'Licio hat die für {region} erforderliche rechtliche Prüfung noch nicht abgeschlossen. Die Funktion bleibt dort deaktiviert, bis diese Prüfung abgeschlossen ist — niemals stillschweigend aktiv.',
  'disabled.wallet_connection.policy_missing':
    'Für {region} wurde noch keine Jurisdiktionsrichtlinie freigegeben; die Funktion ist daher standardmäßig deaktiviert (fail-closed).',
  'disabled.wallet_connection.age_restricted':
    'Finanzfunktionen erfordern ein bestätigtes Erwachsenenkonto (Plattformrichtlinie §19.4).',
  'disabled.wallet_connection.compliance_hold':
    'Ihr Konto befindet sich in einer Compliance-Prüfung. Finanzfunktionen bleiben pausiert, bis diese abgeschlossen ist.',
  'disabled.wallet_connection.policy_not_yet_effective':
    'Die Jurisdiktionsrichtlinie für {region} wurde freigegeben, ist aber noch nicht in Kraft. Die Funktion wird am Stichtag automatisch aktiviert.',
  'disabled.wallet_connection.unknown_region':
    'Licio ermittelt niemals Ihren Aufenthaltsort (keine Standort- oder Netzwerkadressen-Abfragen). Ohne eine Region in Ihrem Konto bleiben Finanzfunktionen deaktiviert.',
  'disabled.wallet_connection.verification_required':
    'Echtgeld-Funktionen in {region} erfordern eine verifizierte Regionserklärung. Ihre aktuelle Region stammt aus Ihrer Sprach-/Regionseinstellung und ist nicht verifiziert.',
  'disabled.testnet_transactions.region_unsupported':
    'Licio hat die für {region} erforderliche rechtliche Prüfung noch nicht abgeschlossen. Die Funktion bleibt dort deaktiviert, bis diese Prüfung abgeschlossen ist — niemals stillschweigend aktiv.',
  'disabled.testnet_transactions.policy_missing':
    'Für {region} wurde noch keine Jurisdiktionsrichtlinie freigegeben; die Funktion ist daher standardmäßig deaktiviert (fail-closed).',
  'disabled.testnet_transactions.age_restricted':
    'Finanzfunktionen erfordern ein bestätigtes Erwachsenenkonto (Plattformrichtlinie §19.4).',
  'disabled.testnet_transactions.compliance_hold':
    'Ihr Konto befindet sich in einer Compliance-Prüfung. Finanzfunktionen bleiben pausiert, bis diese abgeschlossen ist.',
  'disabled.testnet_transactions.policy_not_yet_effective':
    'Die Jurisdiktionsrichtlinie für {region} wurde freigegeben, ist aber noch nicht in Kraft. Die Funktion wird am Stichtag automatisch aktiviert.',
  'disabled.testnet_transactions.unknown_region':
    'Licio ermittelt niemals Ihren Aufenthaltsort (keine Standort- oder Netzwerkadressen-Abfragen). Ohne eine Region in Ihrem Konto bleiben Finanzfunktionen deaktiviert.',
  'disabled.testnet_transactions.verification_required':
    'Echtgeld-Funktionen in {region} erfordern eine verifizierte Regionserklärung. Ihre aktuelle Region stammt aus Ihrer Sprach-/Regionseinstellung und ist nicht verifiziert.',
  'disabled.production_payments.region_unsupported':
    'Licio hat die für {region} erforderliche rechtliche Prüfung noch nicht abgeschlossen. Die Funktion bleibt dort deaktiviert, bis diese Prüfung abgeschlossen ist — niemals stillschweigend aktiv.',
  'disabled.production_payments.policy_missing':
    'Für {region} wurde noch keine Jurisdiktionsrichtlinie freigegeben; die Funktion ist daher standardmäßig deaktiviert (fail-closed).',
  'disabled.production_payments.age_restricted':
    'Finanzfunktionen erfordern ein bestätigtes Erwachsenenkonto (Plattformrichtlinie §19.4).',
  'disabled.production_payments.compliance_hold':
    'Ihr Konto befindet sich in einer Compliance-Prüfung. Finanzfunktionen bleiben pausiert, bis diese abgeschlossen ist.',
  'disabled.production_payments.policy_not_yet_effective':
    'Die Jurisdiktionsrichtlinie für {region} wurde freigegeben, ist aber noch nicht in Kraft. Die Funktion wird am Stichtag automatisch aktiviert.',
  'disabled.production_payments.unknown_region':
    'Licio ermittelt niemals Ihren Aufenthaltsort (keine Standort- oder Netzwerkadressen-Abfragen). Ohne eine Region in Ihrem Konto bleiben Finanzfunktionen deaktiviert.',
  'disabled.production_payments.verification_required':
    'Echtgeld-Funktionen in {region} erfordern eine verifizierte Regionserklärung. Ihre aktuelle Region stammt aus Ihrer Sprach-/Regionseinstellung und ist nicht verifiziert.',
  'disabled.treasury_operations.region_unsupported':
    'Licio hat die für {region} erforderliche rechtliche Prüfung noch nicht abgeschlossen. Die Funktion bleibt dort deaktiviert, bis diese Prüfung abgeschlossen ist — niemals stillschweigend aktiv.',
  'disabled.treasury_operations.policy_missing':
    'Für {region} wurde noch keine Jurisdiktionsrichtlinie freigegeben; die Funktion ist daher standardmäßig deaktiviert (fail-closed).',
  'disabled.treasury_operations.age_restricted':
    'Finanzfunktionen erfordern ein bestätigtes Erwachsenenkonto (Plattformrichtlinie §19.4).',
  'disabled.treasury_operations.compliance_hold':
    'Ihr Konto befindet sich in einer Compliance-Prüfung. Finanzfunktionen bleiben pausiert, bis diese abgeschlossen ist.',
  'disabled.treasury_operations.policy_not_yet_effective':
    'Die Jurisdiktionsrichtlinie für {region} wurde freigegeben, ist aber noch nicht in Kraft. Die Funktion wird am Stichtag automatisch aktiviert.',
  'disabled.treasury_operations.unknown_region':
    'Licio ermittelt niemals Ihren Aufenthaltsort (keine Standort- oder Netzwerkadressen-Abfragen). Ohne eine Region in Ihrem Konto bleiben Finanzfunktionen deaktiviert.',
  'disabled.treasury_operations.verification_required':
    'Echtgeld-Funktionen in {region} erfordern eine verifizierte Regionserklärung. Ihre aktuelle Region stammt aus Ihrer Sprach-/Regionseinstellung und ist nicht verifiziert.',
  'disabled.governance.region_unsupported':
    'Licio hat die für {region} erforderliche rechtliche Prüfung noch nicht abgeschlossen. Die Funktion bleibt dort deaktiviert, bis diese Prüfung abgeschlossen ist — niemals stillschweigend aktiv.',
  'disabled.governance.policy_missing':
    'Für {region} wurde noch keine Jurisdiktionsrichtlinie freigegeben; die Funktion ist daher standardmäßig deaktiviert (fail-closed).',
  'disabled.governance.age_restricted':
    'Finanzfunktionen erfordern ein bestätigtes Erwachsenenkonto (Plattformrichtlinie §19.4).',
  'disabled.governance.compliance_hold':
    'Ihr Konto befindet sich in einer Compliance-Prüfung. Finanzfunktionen bleiben pausiert, bis diese abgeschlossen ist.',
  'disabled.governance.policy_not_yet_effective':
    'Die Jurisdiktionsrichtlinie für {region} wurde freigegeben, ist aber noch nicht in Kraft. Die Funktion wird am Stichtag automatisch aktiviert.',
  'disabled.governance.unknown_region':
    'Licio ermittelt niemals Ihren Aufenthaltsort (keine Standort- oder Netzwerkadressen-Abfragen). Ohne eine Region in Ihrem Konto bleiben Finanzfunktionen deaktiviert.',
  'disabled.governance.verification_required':
    'Echtgeld-Funktionen in {region} erfordern eine verifizierte Regionserklärung. Ihre aktuelle Region stammt aus Ihrer Sprach-/Regionseinstellung und ist nicht verifiziert.',
  'disabled.next_step.compliance_hold':
    'Wenden Sie sich an den Support, falls dies unerwartet ist.',
  'disabled.next_step.unknown_region':
    'Erklären Sie Ihre Region in den Kontoeinstellungen, um fortzufahren.',
  'disabled.next_step.verification_required':
    'Lassen Sie Ihre Regionserklärung in den Kontoeinstellungen verifizieren.',
};

export default messages;
