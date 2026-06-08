import createDOMPurify, { type Config, type DOMPurify } from 'dompurify';

type TrustedTypesPolicyFactory = {
  createPolicy: (
    name: string,
    policy: {
      createHTML?: (input: string) => string;
      createScript?: (input: string) => string;
      createScriptURL?: (input: string) => string;
    },
  ) => unknown;
};

type WindowWithTrustedTypes = Window & {
  trustedTypes?: TrustedTypesPolicyFactory;
};

type DOMPurifyFactory = typeof createDOMPurify & {
  sanitize?: DOMPurify['sanitize'];
};

let bootstrapped = false;
let purifierForTests: DOMPurify | undefined;

function getPurifier(win: Window = window): DOMPurify {
  const candidate = createDOMPurify as DOMPurifyFactory;
  if (candidate.sanitize !== undefined) {
    return candidate as DOMPurify;
  }
  purifierForTests ??= createDOMPurify(win as unknown as Parameters<typeof createDOMPurify>[0]);
  return purifierForTests;
}

export function bootstrapTrustedTypes(win: WindowWithTrustedTypes = window): void {
  if (bootstrapped || win.trustedTypes === undefined) {
    bootstrapped = true;
    return;
  }

  win.trustedTypes.createPolicy('default', {
    createHTML() {
      throw new TypeError('Raw HTML is not permitted. Use the dompurify policy.');
    },
    createScript() {
      throw new TypeError('Raw scripts are never permitted.');
    },
    createScriptURL() {
      throw new TypeError('Raw script URLs are never permitted.');
    },
  });

  win.trustedTypes.createPolicy('dompurify', {
    createHTML(input: string) {
      return getPurifier(win).sanitize(input, { RETURN_TRUSTED_TYPE: false });
    },
  });

  bootstrapped = true;
}

export function sanitizeToTrustedHtml(input: string, win: Window = window): TrustedHTML | string {
  const config: Config = { RETURN_TRUSTED_TYPE: true };
  return getPurifier(win).sanitize(input, config);
}
