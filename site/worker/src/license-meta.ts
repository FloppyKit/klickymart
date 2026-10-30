/** SPDX identifiers for API and docs (Matt 2026-10-29). */
export const LICENSE_CODE = "MIT";
export const LICENSE_CODE_URL = "https://opensource.org/licenses/MIT";
export const LICENSE_DATA = "CC0-1.0";
export const LICENSE_DATA_URL = "https://creativecommons.org/publicdomain/zero/1.0/";

export function licenseMetaBlock(): {
  license: { code: string; code_url: string; data: string; data_url: string };
} {
  return {
    license: {
      code: LICENSE_CODE,
      code_url: LICENSE_CODE_URL,
      data: LICENSE_DATA,
      data_url: LICENSE_DATA_URL,
    },
  };
}

export function licenseResponseHeaders(): Record<string, string> {
  return {
    "X-KM-Code-License": LICENSE_CODE,
    "X-KM-Data-License": LICENSE_DATA,
    "X-KM-Third-Party-Data": "records with seed_license=ODbL-1.0 were seeded from BTC Map, (c) OpenStreetMap contributors, ODbL 1.0 (https://opendatacommons.org/licenses/odbl/1-0/); see /about#credits",
    Link: '</openapi.json>; rel="describedby", </DATA-LICENSE>; rel="license"; type="text/plain"; title="Data license CC0-1.0"',
  };
}
