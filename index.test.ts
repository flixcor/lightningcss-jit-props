// adapted from https://github.com/GoogleChromeLabs/postcss-jit-props/blob/main/index.test.js
import { browserslistToTargets, bundle, transform } from 'lightningcss'
import plugin, { Options } from './'
import { expect, it, vi } from 'vitest'
import { readFileSync, /*writeFileSync*/ } from 'node:fs'
import * as prettier from "prettier"

const MockProps = {
  '--red': '#e44',
  '--pink': '#d98997',
  '--h': 200,
  '--s': '50%',
  '--l': '50%',
  '--size-1': '1rem',
  '--size-2': '2rem',
  '--fade-in': 'fade-in .5s ease',
  '--fade-in-@': '@keyframes fade-in {to { opacity: 1 }}',
  '--adaptive-fade': 'adaptive-fade .5s ease',
  '--adaptive-fade-@': '@keyframes adaptive-fade {to { background: #fff }}',
  '--adaptive-fade-@media:dark': '@keyframes adaptive-fade {to { background: #000 }}',
  '--dark': '@custom-media --dark (prefers-color-scheme: dark);',
  '--text': '#fff',
  '--text-@media:dark': '#000',
} as const

const MockPropsWithCustomAdaptiveProp = {
  '--text': '#fff',
  '--text-dark': '#000',
}

function run(input: string, output: string, options: Options = {}) {
  const result = transform({
    filename: "input.css",
    code: Buffer.from(input),
    visitor: plugin(options),
  })
  const code = result.code.toString();
  expect(code.trim()).toEqual(output)
  expect(result.warnings).toHaveLength(0)

  // const map = result.map.toJSON()
  // expect(map.sources).toEqual(['input.css'])
}

it('Can jit a single prop', () => {
  run(
    `a {
  color: var(--red);
}`,
    `:root {
  --red: #e44;
}

a {
  color: var(--red);
}`,
    MockProps
  )
})

it('Can jit a single prop with spaces', () => {
  run(
    `a {
  color: var( --red );
}`,
    `:root {
  --red: #e44;
}

a {
  color: var(--red);
}`,
    MockProps
  )
})

it('Can jit a single prop that has fallbacks', () => {
  run(
    `a {
  color: var(--red, hotpink);
}`,
    `:root {
  --red: #e44;
}

a {
  color: var(--red, hotpink);
}`,
    MockProps
  )
})

it('Can jit a single prop with spaces that has fallbacks', () => {
  run(
    `a {
  color: var(  --red, hotpink);
}`,
    `:root {
  --red: #e44;
}

a {
  color: var(--red, hotpink);
}`,
    MockProps
  )
})

it('Can jit a single prop that has fallbacks and nested props', () => {
  run(
    `a {
  color: var(--red, var(--pink), hotpink);
}`,
    `:root {
  --red: #e44;
  --pink: #d98997;
}

a {
  color: var(--red, var(--pink), hotpink);
}`,
    MockProps
  )
})

it('Can jit a single, undefined prop that has fallbacks and nested props', () => {
  run(
    `a {
  color: var(--orange, var(--pink), hotpink);
}`,
    `:root {
  --pink: #d98997;
}

a {
  color: var(--orange, var(--pink), hotpink);
}`,
    MockProps
  )
})


it('Can jit a single prop with spaces that has fallbacks and nested props', () => {
  run(
    `a {
  color: var( --red, var( --pink ), hotpink);
}`,
    `:root {
  --red: #e44;
  --pink: #d98997;
}

a {
  color: var(--red, var(--pink), hotpink);
}`,
    MockProps
  )
})

it('Can jit multiple props', () => {
  run(
    `a {
  color: var(--red);
  border-color: var(--pink);
  padding-block-start: var( --size-1 );
}`,
    `:root {
  --red: #e44;
  --pink: #d98997;
  --size-1: 1rem;
}

a {
  color: var(--red);
  border-color: var(--pink);
  padding-block-start: var(--size-1);
}`,
    MockProps
  )
})

it('Can jit multiple props from shorthand', () => {
  run(
    `a {
  padding-block: var(--size-1) var( --size-2  );
}`,
    `:root {
  --size-1: 1rem;
  --size-2: 2rem;
}

a {
  padding-block: var(--size-1) var(--size-2);
}`,
    MockProps
  )
})

it('Can jit props from inside functions', () => {
  run(
    `a {
  color: hsl(var(--h) var(--s) var( --l ));
}`,
    `:root {
  --h: 200;
  --s: 50.0%;
  --l: 50.0%;
}

a {
  color: hsl(var(--h) var(--s) var(--l));
}`,
    MockProps
  )
})

it('Only adds a prop one time to :root', () => {
  run(
    `a {
  color: var(--red);
  border-color: var(--red );
}`,
    `:root {
  --red: #e44;
}

a {
  color: var(--red);
  border-color: var(--red);
}`,
    MockProps
  )
})

it('Can jit props into a layer', () => {
  run(
    `a {
  color: hsl(var(--h) var(--s) var( --l ));
}`,
    `@layer test {
  :root {
    --h: 200;
    --s: 50.0%;
    --l: 50.0%;
  }
}

a {
  color: hsl(var(--h) var(--s) var(--l));
}`,
    {
      ...MockProps,
      layer: 'test',
    }
  )
})

it('Can jit a keyframe animation', () => {
  run(
    `a {
  animation: var(--fade-in);
}`,
    `:root {
  --fade-in: fade-in .5s ease;
}

@keyframes fade-in {
  to {
    opacity: 1;
  }
}

a {
  animation: var(--fade-in);
}`,
    MockProps
  )
})

it('Can jit an adaptive keyframe animation', () => {
  run(
    `a {
  animation: var(--adaptive-fade);
}`,
    `:root {
  --adaptive-fade: adaptive-fade .5s ease;
}

@keyframes adaptive-fade {
  to {
    background: #fff;
  }
}

@media (prefers-color-scheme: dark) {
  @keyframes adaptive-fade {
    to {
      background: #000;
    }
  }
}

a {
  animation: var(--adaptive-fade);
}`,
    MockProps //
  )
})

it('Can jit @custom-media', () => {
  run(
    `@media (--dark) {
  a {
    color: #fff;
  }
}`,
    `@custom-media --dark (prefers-color-scheme: dark);

@media (--dark) {
  a {
    color: #fff;
  }
}`,
    MockProps
  )
})

it('Can jit @custom-media with spaces', () => {
  run(
    `@media ( --dark ) {
  a {
    color: #fff;
  }
}`,
    `@custom-media --dark (prefers-color-scheme: dark);

@media (--dark) {
  a {
    color: #fff;
  }
}`,
    MockProps
  )
})

it('Can jit props from JSON', () => {
  run(
    `a {
  color: var(--red);
  border-color: var( --pink  );
}`,
    `:root {
  --red: #e44;
  --pink: #d98997;
}

a {
  color: var(--red);
  border-color: var(--pink);
}`,
    MockProps
  )
})

it('Can jit props from a CSS file', () => {
  run(
    `@media (--dark) {
  a {
    color: var(--red);
    border-color: var( --pink );
    animation: var(--fade-in);
  }
}`,
    `@custom-media --dark (prefers-color-scheme: dark);

:root {
  --red: #e44;
  --pink: #d98997;
  --fade-in: fade-in .5s ease;
}

@keyframes fade-in {
  to {
    opacity: 1;
  }
}

@media (--dark) {
  a {
    color: var(--red);
    border-color: var(--pink);
    animation: var(--fade-in);
  }
}`,
    { files: ['./props.test.css'] }
  )
})

it('Can jit props from a CSS file via glob', () => {
  run(
    `@media (--dark) {
  a {
    color: var(--red);
    border-color: var( --pink );
    animation: var(--fade-in);
  }
}`,
    `@custom-media --dark (prefers-color-scheme: dark);

:root {
  --red: #e44;
  --pink: #d98997;
  --fade-in: fade-in .5s ease;
}

@keyframes fade-in {
  to {
    opacity: 1;
  }
}

@media (--dark) {
  a {
    color: var(--red);
    border-color: var(--pink);
    animation: var(--fade-in);
  }
}`,
    { files: ['./*.test.css'] }
  )
})

it('Can fail without srcProps options gracefully', () => {
  const consoleMock = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  plugin({})
  expect(consoleMock).toHaveBeenCalledWith('lightningcss-jit-props: Variable source(s) not passed.')
})

it('Can jit props to a custom selector', () => {
  run(
    `a {
  color: var(--red);
}`,
    `:global {
  --red: #e44;
}

a {
  color: var(--red);
}`,
    {
      ...MockProps,
      custom_selector: [{ type: 'pseudo-class', kind: 'custom', name: 'global' }],
    }
  )
})

it('Can jit light and dark props to a custom selector', () => {
  run(
    `a {
  color: var(--text);
}`,
    `:global {
  --text: #fff;
}

@media (prefers-color-scheme: dark) {
  :global {
    --text: #000;
  }
}

a {
  color: var(--text);
}`,
    {
      ...MockProps,
      custom_selector: [{ type: 'pseudo-class', kind: 'custom', name: 'global' }],
    }
  )
})

it('Can jit light & dark props to a custom selector for use with a client side switch', () => {
  run(
    `a {
  color: var(--text);
}`,
    `.light {
  --text: #fff;
}

@media (prefers-color-scheme: dark) {
  .dark {
    --text: #000;
  }
}

a {
  color: var(--text);
}`,
    {
      ...MockProps,
      custom_selector: [{ type: 'class', name: 'light' }],
      custom_selector_dark: [{ type: 'class', name: 'dark' }],
    }
  )
})

it('Wont create a :root {} context unless props are found', () => {
  run(
    `a {
  color: red;
}`,
    `a {
  color: red;
}`,
    {
      ...MockProps
    }
  )
})

it('Can jit a light and dark adaptive prop', () => {
  run(
    `p {
  color: var(--text);
}`,
    `:root {
  --text: #fff;
}

@media (prefers-color-scheme: dark) {
  :root {
    --text: #000;
  }
}

p {
  color: var(--text);
}`,
    MockProps
  )
})

it('Can jit a light and dark color with a custom adaptive prop parameter', () => {
  run(
    `p {
  color: var(--text);
}`,
    `:root {
  --text: #fff;
}

@media (prefers-color-scheme: dark) {
  :root {
    --text: #000;
  }
}

p {
  color: var(--text);
}`,
    {
      ...MockPropsWithCustomAdaptiveProp,
      adaptive_prop_selector: '-dark'
    }
  )
})

// it('Supports parallel runners', async () => {
//   const pluginInstance = plugin({
//     '--red': '#e44',
//     '--pink': '#d98997',
//   });

//   let [resultA, resultB, resultC, resultD] = await Promise.all([
//     bundleAsync([pluginInstance]).process(`a { color: var(--red); }`, { from: undefined }),
//     postcss([pluginInstance]).process(`a { color: var(--pink); }`, { from: undefined }),
//     postcss([pluginInstance]).process(`a { color: var(--red); }`, { from: undefined }),
//     postcss([pluginInstance]).process(`a { color: var(--pink); }`, { from: undefined }),
//   ])

//   let resultE = await postcss([pluginInstance]).process(`a { color: green; }`, { from: undefined })

//   expect(resultA.css).toEqual(':root { --red: #e44; }\na { color: var(--red); }')
//   expect(resultA.warnings()).toHaveLength(0)

//   expect(resultB.css).toEqual(':root { --pink: #d98997; }\na { color: var(--pink); }')
//   expect(resultB.warnings()).toHaveLength(0)

//   expect(resultC.css).toEqual(':root { --red: #e44; }\na { color: var(--red); }')
//   expect(resultC.warnings()).toHaveLength(0)

//   expect(resultD.css).toEqual(':root { --pink: #d98997; }\na { color: var(--pink); }')
//   expect(resultD.warnings()).toHaveLength(0)

//   expect(resultE.css).toEqual('a { color: green; }')
//   expect(resultE.warnings()).toHaveLength(0)
// })

// it('Supports parallel runners when reading from a file', async () => {
//   const pluginInstance = plugin({ files: ['./props.test.css'] });

//   let [resultA, resultB, resultC, resultD] = await Promise.all([
//     postcss([pluginInstance]).process(`a { color: var(--red); }`, { from: undefined }),
//     postcss([pluginInstance]).process(`a { color: var(--pink); }`, { from: undefined }),
//     postcss([pluginInstance]).process(`a { color: var(--red); }`, { from: undefined }),
//     postcss([pluginInstance]).process(`a { color: var(--pink); }`, { from: undefined }),
//   ])

//   let resultE = await postcss([pluginInstance]).process(`a { color: green; }`, { from: undefined })

//   expect(resultA.css).toEqual(':root { --red: #e44; }\na { color: var(--red); }')
//   expect(resultA.warnings()).toHaveLength(0)

//   expect(resultB.css).toEqual(':root { --pink: #d98997; }\na { color: var(--pink); }')
//   expect(resultB.warnings()).toHaveLength(0)

//   expect(resultC.css).toEqual(':root { --red: #e44; }\na { color: var(--red); }')
//   expect(resultC.warnings()).toHaveLength(0)

//   expect(resultD.css).toEqual(':root { --pink: #d98997; }\na { color: var(--pink); }')
//   expect(resultD.warnings()).toHaveLength(0)

//   expect(resultE.css).toEqual('a { color: green; }')
//   expect(resultE.warnings()).toHaveLength(0)
// })

// situation encountered when using postcs-jit-props for Open Props
// together with having @nuxt/fonts module with no global font definition
// it still creates an empty .nuxt/nuxt-fonts-global.css file
// and postcs-jit-props started to fail trying to parse it
// --
// fixed by adding "node.first" null check into parsing method
// (lines 130 and 136 in index.js)

it('Parses an empty file and rule', () => {
  const pluginInstance = plugin({ files: ['./props.test.empty.css'] });
  const result = transform({ visitor: pluginInstance, code: Buffer.from(''), filename: 'input.css' })
  expect(result.code.toString().trim()).toEqual("");
  expect(result.warnings).toHaveLength(0);
})

const prettierCss = (c: string) => prettier.format(c, { parser: 'css' })

it("handles openprops", async () => {
  const targets = browserslistToTargets([">= 0.25%"])
  const options = {
    files: [
      'node_modules/open-props/open-props.min.css', 
      'node_modules/open-props/media.min.css',
      "node_modules/open-props/animations.min.css"
    ],
    layer: 'my-layer',
    targets
  }
  const { warnings, code } = bundle({
    filename: 'test-with-openprops-normalize-input.css',
    visitor: plugin(options),
    drafts: { customMedia: true },
    targets,
    minify: true
  })
  const pretty = await prettierCss(code.toString())
  // writeFileSync("test-with-openprops-normalize-output.css", pretty)
  expect(warnings).toHaveLength(0)
  const expectedOutput = readFileSync("test-with-openprops-normalize-output.css", { encoding: 'utf-8' })
  expect(pretty).toEqual(expectedOutput)
})
