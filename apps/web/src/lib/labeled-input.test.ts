import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LabeledInput } from "../components/labeled-input";

function field(label: string, id?: string) {
  return createElement(LabeledInput, {
    label,
    icon: null,
    className: "field",
    children: createElement("input", { id, type: "email", disabled: true }),
  });
}

describe("form control labels", () => {
  it("connects each label to a unique control without losing input properties", () => {
    const html = renderToStaticMarkup(createElement(Fragment, null, field("Email"), field("Backup email")));
    const labels = [...html.matchAll(/<label[^>]*for="([^"]+)"/g)].map((match) => match[1]);
    const inputs = [...html.matchAll(/<input[^>]*id="([^"]+)"/g)].map((match) => match[1]);
    expect(labels).toHaveLength(2);
    expect(new Set(labels).size).toBe(2);
    expect(inputs).toEqual(labels);
    expect(html).toContain('class="sr-only">Email</span>');
    expect(html.match(/disabled=""/g)).toHaveLength(2);
  });

  it("preserves an existing input id and an adjacent suffix", () => {
    const html = renderToStaticMarkup(
      createElement(LabeledInput, {
        label: "Subdomain",
        icon: null,
        className: "field",
        children: [
          createElement("input", { id: "workspace", key: "input" }),
          createElement("span", { key: "suffix" }, ".example.test"),
        ],
      }),
    );
    expect(html).toContain('for="workspace"');
    expect(html).toContain('id="workspace"');
    expect(html).toContain(".example.test");
  });

  it("rejects a label with no control instead of rendering an unassociated label", () => {
    expect(() =>
      renderToStaticMarkup(
        createElement(LabeledInput, {
          label: "Email",
          icon: null,
          className: "field",
          children: createElement("span", null, "Missing input"),
        }),
      ),
    ).toThrow("requires exactly one form control");
  });
});
