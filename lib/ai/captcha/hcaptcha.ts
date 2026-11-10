import type { BrowserChallengeObservation, CaptchaWidget } from "./detection";

// Explicit render() integrations need not retain a class or data-sitekey. Bind
// the provider's checkbox frame to its own SDK-created response fields instead.
// DOM references and SDK responses stay inside the owned page.
export const RENDERED_HCAPTCHA_WIDGETS = String.raw`(() => {
  const widgets = [];
  for (const frame of document.querySelectorAll('iframe')) {
    if (widgets.length === 10) break;
    let source;
    try { source = new URL(frame.src); } catch { continue; }
    if (source.protocol !== 'https:' || source.username || source.password ||
        !(source.hostname === 'hcaptcha.com' || source.hostname.endsWith('.hcaptcha.com')) ||
        !source.pathname.endsWith('/hcaptcha.html')) continue;
    const parameters = new URLSearchParams(source.hash.slice(1));
    if (parameters.get('frame') !== 'checkbox' ||
        ['frame','id','sitekey'].some(key => parameters.getAll(key).length !== 1)) continue;
    const widgetId = parameters.get('id');
    const siteKey = parameters.get('sitekey');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(widgetId || '') ||
        !/^[A-Za-z0-9_-]{10,256}$/.test(siteKey || '')) continue;
    const element = frame.parentElement;
    if (!element || element.matches('body,html')) continue;
    const fields = [...element.querySelectorAll('[name="h-captcha-response"]')]
      .filter(field => field.parentElement === element && field.id === 'h-captcha-response-' + widgetId &&
        field.matches('textarea,input[type="hidden"]'));
    const compatibilityFields = [...element.querySelectorAll('[name="g-recaptcha-response"]')]
      .filter(field => field.parentElement === element && field.id === 'g-recaptcha-response-' + widgetId &&
        field.matches('textarea,input[type="hidden"]'));
    if (fields.length !== 1 || compatibilityFields.length > 1 ||
        typeof window.hcaptcha?.getResponse !== 'function') continue;
    // Refuse SDKs whose public methods cannot be safely adapted before spending.
    let adaptable = true;
    try {
      for (const name of ['getResponse','reset','remove']) {
        if (typeof window.hcaptcha[name] !== 'function') continue;
        let owner = window.hcaptcha;
        let descriptor;
        while (owner && !(descriptor = Object.getOwnPropertyDescriptor(owner, name)))
          owner = Object.getPrototypeOf(owner);
        if (!descriptor || !('value' in descriptor) || descriptor.writable !== true ||
            (owner !== window.hcaptcha && !Object.isExtensible(window.hcaptcha))) adaptable = false;
      }
    } catch { adaptable = false; }
    if (!adaptable) continue;
    let sdkResponse;
    try { sdkResponse = window.hcaptcha.getResponse(widgetId); } catch { continue; }
    if (typeof sdkResponse !== 'string') continue;
    const bounds = frame.getBoundingClientRect();
    const style = getComputedStyle(frame);
    widgets.push({element, frame, field:fields[0], compatibilityField:compatibilityFields[0],
      container:element.closest('form') || element,
      widgetId, siteKey, source:frame.src,
      tokenPresent:!!fields[0].value || !!compatibilityFields[0]?.value || !!sdkResponse,
      invisible:parameters.get('size') === 'invisible' || frame.hidden || element.hidden ||
        style.display === 'none' || style.visibility === 'hidden' || bounds.width <= 0 || bounds.height <= 0});
  }
  return widgets;
})()`;

export function buildDeliverRenderedHcaptchaScript(
  observation: BrowserChallengeObservation,
  widget: CaptchaWidget,
  token: string,
): string {
  return `((expected, widget, token) => {
    if (location.href !== expected.url || String(performance.timeOrigin) !== expected.documentId)
      return {status:'page_changed'};
    const matches = ${RENDERED_HCAPTCHA_WIDGETS}.filter(candidate =>
      candidate.widgetId === widget.hcaptchaWidgetId && candidate.siteKey === widget.siteKey);
    if (matches.length !== 1) return {status:'page_changed'};
    const current = matches[0];
    const {element, frame, field, compatibilityField, widgetId, source, container} = current;
    const observed = element[Symbol.for('hackerai.captchaObservation')];
    if (!observed || observed.observationId !== widget.observationId ||
        observed.frame !== frame || observed.field !== field || observed.source !== source ||
        observed.compatibilityField !== compatibilityField || observed.container !== container ||
        current.tokenPresent || current.invisible)
      return {status:'page_changed'};
    const api = window.hcaptcha;
    const originalGetResponse = api.getResponse;
    const originalReset = api.reset;
    const originalRemove = api.remove;
    const expiresAt = Date.now() + 120000;
    let expiryTimer;
    let observer;
    let live = true;
    const isCurrent = () => live && Date.now() < expiresAt && window.hcaptcha === api &&
      api.getResponse === getResponse && element.isConnected && frame.parentElement === element &&
      frame.src === source && field.parentElement === element &&
      (element.closest('form') || element) === container &&
      field.id === 'h-captcha-response-' + widgetId && field.name === 'h-captcha-response' && field.value === token &&
      element.querySelectorAll('[name="h-captcha-response"][id="h-captcha-response-' + widgetId + '"]').length === 1 &&
      element.querySelectorAll('[name="g-recaptcha-response"][id="g-recaptcha-response-' + widgetId + '"]').length === (compatibilityField ? 1 : 0) &&
      (!compatibilityField || (compatibilityField.parentElement === element &&
        compatibilityField.id === 'g-recaptcha-response-' + widgetId &&
        compatibilityField.name === 'g-recaptcha-response' && compatibilityField.value === token));
    const restore = () => {
      live = false;
      clearTimeout(expiryTimer);
      observer?.disconnect();
      try { if (api.getResponse === getResponse) api.getResponse = originalGetResponse; } catch {}
      try { if (api.reset === reset) api.reset = originalReset; } catch {}
      try { if (api.remove === remove) api.remove = originalRemove; } catch {}
      if (field.value === token) field.value = '';
      if (compatibilityField?.value === token) compatibilityField.value = '';
    };
    // Use the public getter contract, never SDK internals or fake checkbox UI.
    // Only this explicitly addressed widget receives the external response.
    // A no-argument getter keeps its native default-widget semantics; DOM order
    // cannot establish which SDK widget is the default. Retention is not acceptance.
    function getResponse(id) {
      if (!isCurrent()) restore();
      else if (id === widgetId) return token;
      return originalGetResponse.apply(this, arguments);
    }
    function reset(id) {
      if (id == null || id === widgetId) restore();
      return originalReset.apply(this, arguments);
    }
    function remove(id) {
      if (id == null || id === widgetId) restore();
      return originalRemove.apply(this, arguments);
    }
    try {
      api.getResponse = getResponse;
      if (typeof originalReset === 'function') api.reset = reset;
      if (typeof originalRemove === 'function') api.remove = remove;
      if (api.getResponse !== getResponse ||
          (typeof originalReset === 'function' && api.reset !== reset) ||
          (typeof originalRemove === 'function' && api.remove !== remove)) {
        restore();
        return {status:'page_changed'};
      }
      field.value = token;
      if (compatibilityField) compatibilityField.value = token;
      expiryTimer = setTimeout(restore, 120000);
      observer = new MutationObserver(() => { if (!isCurrent()) restore(); });
      observer.observe(document, {childList:true, subtree:true, attributes:true,
        attributeFilter:['src','id','name']});
      for (const responseField of [field, compatibilityField].filter(Boolean)) {
        responseField.dispatchEvent(new Event('input', {bubbles:true}));
        responseField.dispatchEvent(new Event('change', {bubbles:true}));
      }
      const retained = isCurrent();
      if (!retained) restore();
      return {status:'token_delivered', websiteAccepted:false, responseRetained:retained};
    } catch {
      restore();
      return {status:'page_changed'};
    }
  })(${JSON.stringify({ url: observation.url, documentId: observation.documentId })}, ${JSON.stringify(widget)}, ${JSON.stringify(token)})`;
}
