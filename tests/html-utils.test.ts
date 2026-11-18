import { describe, it, expect } from 'vitest';
import { escapeAttr, escapeHtml, html, joinHtml, raw, SafeHtml } from '../src/client/html-utils.js';

describe('escapeHtml', () => {
  it('escapes quotes too, so it is safe inside an attribute', () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&`)).toBe('&lt;a href=&quot;x&quot; onclick=&#x27;y&#x27;&gt;&amp;');
    expect(escapeAttr('"')).toBe('&quot;');
  });
});

describe('html', () => {
  it('escapes plain values in text and attributes', () => {
    const name = `"><img src=x onerror=alert(1)>`;
    expect(html`<span title="${name}">${name}</span>`.toString()).toBe(
      '<span title="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;">&quot;&gt;&lt;img src=x onerror=alert(1)&gt;</span>'
    );
  });

  it('nests SafeHtml as is, and raw() marks trusted markup', () => {
    const icon = raw('<svg></svg>');
    const inner = html`<b>${'<i>'}</b>`;
    expect(html`<p>${icon}${inner}</p>`.toString()).toBe('<p><svg></svg><b>&lt;i&gt;</b></p>');
  });

  it('joins arrays and renders nothing for null, undefined and false', () => {
    const items = ['a', '<b>'];
    expect(html`<ul>${items.map((i) => html`<li>${i}</li>`)}</ul>`.toString()).toBe('<ul><li>a</li><li>&lt;b&gt;</li></ul>');
    expect(html`${null}${undefined}${false}${0}`.toString()).toBe('0');
    expect(html`${false && html`<x>`}`.toString()).toBe('');
  });

  it('joinHtml escapes plain strings among fragments', () => {
    expect(joinHtml([html`<i>a</i>`, '<b>'], ' · ').toString()).toBe('<i>a</i> · &lt;b&gt;');
    expect(joinHtml([html`<i>a</i>`, html`<i>b</i>`], raw('<br>')).toString()).toBe('<i>a</i><br><i>b</i>');
  });

  it('is a SafeHtml', () => {
    expect(html`x`).toBeInstanceOf(SafeHtml);
  });
});
