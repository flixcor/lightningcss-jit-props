// adapted from https://github.com/GoogleChromeLabs/postcss-jit-props/blob/main/index.js
// import { readFileSync } from 'node:fs'
// import crypto from "node:crypto"
import glob from "tiny-glob/sync.js"
import { Buffer } from "node:buffer"
import {
    bundle,
    transform
} from 'lightningcss';
import type {
    CustomMediaRule as _CustomMediaRule,
    CustomAtRules,
    KeyframesRule as _KeyframesRule,
    MediaRule as _MediaRule,
    ReturnedDeclaration,
    Visitor as _Visitor,
    ReturnedMediaQuery,
    Selector,

    MediaCondition,
    StyleSheet,
    ReturnedRule,
    Rule,
    DeclarationBlock as _DeclarationBlock,
    PageMarginRule as _PageMarginRule,
    Targets,
} from 'lightningcss'

type CustomMediaRule = _CustomMediaRule<ReturnedMediaQuery>
type KeyframesRule = _KeyframesRule<ReturnedDeclaration>
type MediaRule = _MediaRule<ReturnedDeclaration, ReturnedMediaQuery>
type Visitor = _Visitor<CustomAtRules>
type PageMarginRule = _PageMarginRule<ReturnedDeclaration>
type DeclarationBlock = _DeclarationBlock<ReturnedDeclaration>

type PropValue = {
    dependencies: string[]
} | null | undefined
type Props = Record<string, PropValue>

export type Options = {
    files?: string[],
    custom_selector?: Selector,
    custom_selector_dark?: Selector,
    adaptive_prop_selector?: string,
    layer?: string,
    targets?: Targets,
} & {
    [k: VariableKey]: string | number
}

type State = {
    mapped: Set<string | number>,
    mapped_dark: Set<string | number>,
    target_rule: ReturnedDeclaration[],
    target_rule_dark: ReturnedDeclaration[],
    target_media_dark: KeyframesRule[],
    keyframes: KeyframesRule[],
    custom_media: CustomMediaRule[],
    media_rules: Map<string, MediaRule>
}


const loc = {
    column: 0,
    line: 0,
    source_index: 0
}

const processed = new WeakSet();

const getState = (): State => (
    {
        mapped: new Set(),            // track prepended props
        mapped_dark: new Set(),       // track dark mode prepended props
        target_rule: [],       // :root for props
        target_rule_dark: [],  // :root for dark props
        target_media_dark: [], // dark media query props
        keyframes: [],
        custom_media: [],
        media_rules: new Map()
    }
)

function* getVars(condition: MediaCondition | null | undefined): Generator<VariableKey> {
    for (const element of getFeatures(condition)) {
        if (isValidKey(element)) yield element
    }
}

function* getFeatures(condition: MediaCondition | null | undefined): Generator<string> {
    if (condition?.type === "not") yield* getFeatures(condition.value)
    else if (condition?.type === "operation") {
        for (const element of condition.conditions) {
            yield* getFeatures(element)
        }
    }
    else if (condition) {
        yield condition.value.name
    }
}

type VariableKey = `--${string}`
const isValidKey = (k: string): k is VariableKey => k.startsWith('--')

function parseProps({
    adaptive_prop_selector,
    custom_selector_dark,
    custom_selector, ...p
}: Options) {
    const stylesheet: StyleSheet<ReturnedDeclaration, ReturnedMediaQuery> = {
        licenseComments: [],
        sourceMapUrls: [],
        sources: [],
        rules: []
    }
    const props: Props = {}
    const rootSelector: Selector = [{ type: 'pseudo-class', kind: 'root' }]
    adaptive_prop_selector ||= '-@media:dark'
    const regularSelector = custom_selector || rootSelector
    const darkSelector = custom_selector_dark || regularSelector
    const styleRules: ReturnedDeclaration[] = []
    const darkRules: ReturnedDeclaration[] = []
    const customMedia: { type: 'custom-media', value: CustomMediaRule }[] = []
    const keyframeRules: { type: 'keyframes', value: KeyframesRule }[] = []

    for (const [property, value] of Object.entries(p)) {
        if (!isValidKey(property)) continue;
        const prop = {
            dependencies: [] as string[]
        }
        if (typeof value === "string") {
            if (value.startsWith('@keyframes')) {
                transform({
                    code: Buffer.from(value),
                    filename: "props.css",
                    visitor: {
                        Rule: {
                            keyframes(r) {
                                keyframeRules.push(r)
                                props[r.value.name.value] = prop
                            }
                        },
                        Variable(v) {
                            prop.dependencies.push(v.name.ident)
                        }
                    }
                })
                continue
            }
            if (value.startsWith('@custom-media')) {
                transform({
                    code: Buffer.from(value),
                    filename: "props.css",
                    visitor: {
                        Rule: {
                            "custom-media"(r) {
                                customMedia.push(r)
                                props[r.value.name] = prop
                            }
                        },
                        Variable(v) {
                            prop.dependencies.push(v.name.ident)
                        }
                    },
                    drafts: {
                        customMedia: true
                    }
                })
                continue
            }
        }

        const [rulesToPush, key] = property.endsWith(adaptive_prop_selector)
            ? [darkRules, property.substring(0, property.length - adaptive_prop_selector.length)]
            : [styleRules, property]

        transform({
            filename: "props.css",
            code: Buffer.from(`:root {${key}: ${value};}`),
            visitor: {
                Declaration(p) {
                    if (p.property === "custom") {
                        rulesToPush.push(p)
                        props[p.value.name] = prop
                    }
                },
                Variable(v) {
                    prop.dependencies.push(v.name.ident)
                }
            }
        })
    }

    stylesheet.rules.push(...customMedia)

    if (styleRules.length) {
        stylesheet.rules.push({
            type: 'style',
            value: {
                selectors: [regularSelector],
                loc,
                declarations: {
                    declarations: styleRules
                }
            }
        })
    }

    if (darkRules.length) {
        stylesheet.rules.push({
            type: 'media',
            value: {
                loc,
                rules: [{
                    type: 'style',
                    value: {
                        selectors: [darkSelector],
                        loc,
                        declarations: {
                            declarations: darkRules
                        }
                    }
                }],
                query: {
                    mediaQueries: [
                        {
                            mediaType: 'all',
                            condition: {
                                type: "feature",
                                value: {
                                    type: 'plain',
                                    name: 'prefers-color-scheme',
                                    value: {
                                        type: "ident",
                                        value: "dark"
                                    }
                                }
                            }
                        }
                    ]
                }
            }
        })
    }

    stylesheet.rules.push(...keyframeRules)

    return [stylesheet, props] as const
}


function* purgeRules<R extends ReturnedRule[] | PageMarginRule[]>(rules: R, vars: Set<string>, addIndex: number): Generator<R extends ReturnedRule[] ? ReturnedRule : PageMarginRule> {
    for (const rule of rules) {
        if (!("type" in rule)) {
            const result = {
                ...rule,
                loc: {
                    ...rule.loc,
                    source_index: rule.loc.source_index + addIndex
                }
            }
            if (result.declarations) {
                result.declarations = purgeDeclarationsBlock(result.declarations, vars)
            }
            yield result as R extends ReturnedRule[] ? ReturnedRule : PageMarginRule;
            continue;
        }
        if (rule.type === "font-feature-values") {
            // page margin rule
            yield {
                ...rule,
                value: {
                    ...rule.value,
                    loc: {
                        ...rule.value.loc,
                        source_index: rule.value.loc.source_index + addIndex
                    },
                    rules: Object.fromEntries(Object.entries(rule.value.rules).map(([key, value]) => [key, {
                        ...value,
                        loc: {
                            ...value.loc,
                            source_index: value.loc.source_index + addIndex,
                        },
                    }]))
                }
            } as R extends ReturnedRule[] ? ReturnedRule : PageMarginRule;
            continue;
        }
        if (rule.type === "keyframes" && !vars.has(rule.value.name.value)) continue;
        if (rule.type === "custom-media") {
            if (!vars.has(rule.value.name)) continue;
            console.log("custom media!", rule.value.name)
        }
        if (!("value" in rule && rule.value)) {
            continue;
        }
        const mappedRule = {
            ...rule,
            value: {
                ...rule.value,
                loc: {
                    ...rule.value.loc,
                    source_index: rule.value.loc.source_index + addIndex
                }
            }
        }
        if ("rules" in mappedRule.value && mappedRule.value.rules) {
            mappedRule.value.rules = [...purgeRules(mappedRule.value.rules, vars, addIndex)] as Rule[] | PageMarginRule[]
        }
        if ("declarations" in mappedRule.value && mappedRule.value.declarations) {
            mappedRule.value.declarations = purgeDeclarationsBlock(mappedRule.value.declarations, vars)
        }
        yield mappedRule as R extends ReturnedRule[] ? ReturnedRule : PageMarginRule
    }
}

function purgeDeclarationsBlock(declarations: DeclarationBlock, vars: Set<string>) {
    const mapped = {
        ...declarations
    }
    if (mapped.declarations) {
        mapped.declarations = [...purgeDeclarations(mapped.declarations, vars)]
    }
    if (mapped.importantDeclarations) {
        mapped.importantDeclarations = [...purgeDeclarations(mapped.importantDeclarations, vars)]
    }
    return mapped
}

function* purgeDeclarations(declarations: ReturnedDeclaration[], vars: Set<string>) {
    for (const declaration of declarations) {

        if (declaration.property === "custom") {
            const name = "value" in declaration ? declaration.value.name : declaration.property
            if (!vars.has(name)) continue;
        }
        yield declaration
    }
}

export default function plugin(options: Options): Visitor {
    const {
        files,
        layer,
        targets,
    } = options

    // const FilePropsCache = new Map();
    const [objStylesheet, UserProps] = parseProps(options)

    const STATE = getState()

    const propStylesheets: StyleSheet<ReturnedDeclaration, ReturnedMediaQuery>[] = [
        objStylesheet
    ]

    if (!files?.length && !Object.keys(UserProps).length) {
        console.warn('lightningcss-jit-props: Variable source(s) not passed.')
        return {}
    }

    if (files?.length) {

        const globs = files
            .map((file) => glob(file))
            .flat()

        globs.forEach((file) => {
            // const data = readFileSync(file)

            // const hashSum = crypto.createHash('sha256')
            // hashSum.update(file)
            // hashSum.update(data)
            // const fileCacheKey = hashSum.digest('hex')

            // if (FilePropsCache.has(fileCacheKey)) {
            //     const [stylesheet, fileProps] = FilePropsCache.get(fileCacheKey)
            //     propStylesheets[i + 1] = stylesheet
            //     Object.assign(UserProps, fileProps)
            //     return
            // }

            // const fileProps = new Map()
            // FilePropsCache.set(fileCacheKey, fileProps)
            type Parent = {
                rules?: Rule[],
                declarations?: DeclarationBlock,
                parent?: Parent
            }
            let parent: Parent = {}
            let parentProp: PropValue | undefined

            bundle({
                filename: file,
                drafts: {
                    customMedia: true
                },
                targets,
                visitor: {
                    StyleSheet(s) {
                        propStylesheets.push(s)
                        parent = {
                            rules: s.rules,
                        }
                    },
                    Rule(rule) {
                        const name = rule.type === "custom-media"
                            ? rule.value.name
                            : rule.type === "keyframes"
                                ? rule.value.name.value
                                : null
                        if (name) {
                            let existing = UserProps[name]
                            if (!existing) {
                                existing = { dependencies: [] }
                                UserProps[name] = existing
                            }

                        }
                        if ('value' in rule && rule.value) {
                            let parentRules, parentDeclarations
                            if ('rules' in rule.value) {
                                parentRules = rule.value.rules as Rule[]
                            }
                            if ('declarations' in rule.value) {
                                parentDeclarations = rule.value.declarations
                            }
                            if (parentRules || parentDeclarations) {
                                parent = {
                                    parent,
                                    rules: parentRules,
                                    declarations: parentDeclarations
                                }
                            }
                        }
                    },
                    RuleExit(rule) {
                        if (parent.parent && 'value' in rule && rule.value) {
                            if ('rules' in rule.value || 'declarations' in rule.value) {
                                parent = parent.parent
                            }
                        }
                    },
                    Declaration(d) {
                        if (d.property === "custom") {
                            const prop = d.value
                            let existing = UserProps[prop.name]
                            if (!existing) {
                                existing = {
                                    dependencies: [],
                                }
                                UserProps[prop.name] = existing
                            }
                            parentProp = existing
                        }
                    },
                    Variable(v) {
                        if (parentProp) {
                            parentProp.dependencies.push(v.name.ident)
                        }
                    },
                    DeclarationExit: {
                        custom() {
                            parentProp = undefined
                        }
                    },
                }
            })
        })
    }

    function* expand(k: string): Generator<string> {
        const found = UserProps[k]
        if (!found) return
        yield k
        for (const dep of found.dependencies) {
            yield* expand(dep)
        }
    }

    return {
        StyleSheet() {
            Object.assign(STATE, getState())
        },

        StyleSheetExit(stylesheet: StyleSheet) {
            if (!propStylesheets.length) return
            const rootRules = stylesheet.rules.filter(r => r.type !== "ignored")

            let rulesToAppend: ReturnedRule[] | undefined,
                rules: ReturnedRule[] | undefined

            if (layer) {
                rulesToAppend = []
                const layerRule: ReturnedRule = {
                    type: 'layer-block',
                    value: {
                        loc,
                        name: [layer],
                        rules: rulesToAppend
                    }
                }
                rules = [layerRule, ...rootRules]
            }
            else {
                rules = rootRules
                rulesToAppend = rules
            }
            let sourceCount = stylesheet.sources.length

            for (const sourceStylesheet of propStylesheets) {
                const purged = purgeRules(sourceStylesheet.rules, STATE.mapped as Set<string>, sourceCount)
                rulesToAppend.unshift(...purged)
                stylesheet.sources.push(...sourceStylesheet.sources)
                stylesheet.sourceMapUrls.push(...sourceStylesheet.sourceMapUrls)
                stylesheet.licenseComments.push(...sourceStylesheet.licenseComments)
                sourceCount += stylesheet.sources.length
            }


            return {
                ...stylesheet,
                rules
            }
        },
        MediaQuery(query) {
            // bail early if possible
            if (processed.has(query)) return;
            for (const prop of getVars(query.condition)) {
                for (const value of expand(prop)) {
                    STATE.mapped.add(value)
                }
            }
            processed.add(query)
        },

        Variable(variable) {
            if (processed.has(variable)) return;
            const { name: { ident: prop } } = variable
            for (const value of expand(prop)) {
                STATE.mapped.add(value)
            }
            processed.add(variable)
        },
    }
}
