// adapted from https://github.com/GoogleChromeLabs/postcss-jit-props/blob/main/index.js
import { readFileSync } from 'node:fs'
import crypto from "node:crypto"
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
    TokenOrValue,
    Variable,
    MediaCondition,
    StyleSheet,
    ReturnedRule,
    StyleRule,
    Rule,
    DeclarationBlock,
    CustomProperty
} from 'lightningcss'
import { Declaration } from 'postcss';

type CustomMediaRule = _CustomMediaRule<ReturnedMediaQuery>
type KeyframesRule = _KeyframesRule<ReturnedDeclaration>
type MediaRule = _MediaRule<ReturnedDeclaration, ReturnedMediaQuery>
type Visitor = _Visitor<CustomAtRules>

type PropValue = {
    dependencies: string[],
    deletion: Array<() => void>
} | null | undefined
type Props = Record<string, PropValue>

export type Options = {
    files?: string[],
    custom_selector?: Selector,
    custom_selector_dark?: Selector,
    adaptive_prop_selector?: string,
    layer?: string,
} & {
    [k: `--${string}`]: string | number
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

const getAdaptivePropSelector = (selector: string | undefined): (s: string) => string =>
    selector
        ? prop => `${prop}${selector}`
        : prop => `${prop}-@media:dark`


function* getVariables(tokenOrValueArray: TokenOrValue[]): Generator<Variable> {
    for (const tokenOrValue of tokenOrValueArray) {
        switch (tokenOrValue.type) {
            case "function":
                yield* getVariables(tokenOrValue.value.arguments)
                break;
            case "var":
                yield tokenOrValue.value
                break;
            // case 'unresolved-color':
            //     yield* getVariables(tokenOrValue.value.alpha);
            //     yield* getVariables(tokenOrValue.value.dark);
            //     yield* getVariables(tokenOrValue.value.light);
            //     break;
            default:
                break;
        }
    }
}

function* getVariableDeclarationRecursive(props: Props, variable: Variable): Generator<ReturnedDeclaration> {
    const declaration = props[variable.name.ident]
    if (!isDeclaration(declaration?.value)) return;
    yield declaration.value
    if (declaration.value.property === "custom" && 'value' in declaration.value) {
        const value = declaration.value.value
        for (const variable of getVariables(value.value)) {
            yield* getVariableDeclarationRecursive(props, variable)
        }
    }
}

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

function* getVars(condition: MediaCondition | null | undefined): Generator<`--${string}`> {
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

const isValidKey = (k: string): k is `--${string}` => k.startsWith('--')

const getMediaRuleKey = (r: MediaRule) => r.query.mediaQueries
    .map(x => [...getMediaQueryKey(x)].join("|"))
    .sort()
    .join('|||')

function* getMediaQueryKey(q: ReturnedMediaQuery): Generator<string> {
    if ('raw' in q) {
        yield q.raw
        return
    }
    yield* getFeatures(q.condition)
    if (q.qualifier) yield q.qualifier
    if (q.mediaType) yield q.mediaType
}

function* parseProps(p: Record<string, string | number>): Generator<[string, PropValue]> {
    for (const [property, value] of Object.entries(p)) {
        if (!isValidKey(property)) continue;

        if (typeof value === "string") {
            if (value.startsWith('@keyframes')) {
                let rule: KeyframesRule | undefined
                transform({
                    code: Buffer.from(value),
                    filename: "props.css",
                    visitor: {
                        Rule: {
                            keyframes(r) {
                                rule = r.value
                            }
                        }
                    }
                })
                if (rule) {
                    yield [property, rule]
                    continue
                }
            }
            if (value.startsWith('@custom-media')) {
                let rule: CustomMediaRule | undefined
                transform({
                    code: Buffer.from(value),
                    filename: "props.css",
                    visitor: {
                        Rule: {
                            "custom-media"(r) {
                                rule = r.value
                            }
                        }
                    },
                    drafts: {
                        customMedia: true
                    }
                })
                if (rule) {
                    yield [property, rule]
                    continue
                }
            }
        }

        yield [property, {
            declaration: {
                property,
                raw: value.toString()
            },
            mediaRules: []
        }]
    }
}

export default function plugin(options: Options): Visitor {
    const {
        files,
        adaptive_prop_selector,
        custom_selector,
        custom_selector_dark,
        layer,
        ...props
    } = options

    const FilePropsCache = new Map();

    const UserProps: Props = Object.fromEntries(parseProps(props))

    const STATE = getState()
    let sourceStylesheet: StyleSheet | undefined

    if (!files?.length && !Object.keys(props).length) {
        console.warn('lightningcss-jit-props: Variable source(s) not passed.')
        return {}
    }

    if (files?.length) {

        const globs = files
            .map((file) => glob(file))
            .flat()

        globs.forEach(file => {
            const data = readFileSync(file)

            const hashSum = crypto.createHash('sha256')
            hashSum.update(file)
            hashSum.update(data)
            const fileCacheKey = hashSum.digest('hex')

            if (FilePropsCache.has(fileCacheKey)) {
                const fileProps = FilePropsCache.get(fileCacheKey)
                for (const [key, value] of fileProps) {
                    UserProps[key] = value
                }

                return
            }

            const fileProps = new Map()
            FilePropsCache.set(fileCacheKey, fileProps)
            let parentRules: Rule[] = []
            let parentDeclarations: DeclarationBlock | undefined
            let parentProp: CustomProperty | undefined

            bundle({
                filename: file,
                drafts: {
                    customMedia: true
                },
                visitor: {
                    StyleSheet({ rules }) {
                        parentRules = rules
                    },
                    Rule(_rule) {
                        const rule = _rule as typeof _rule & { parentRules?: Rule[], parentDeclarations?: DeclarationBlock }
                        rule.parentRules = parentRules
                        rule.parentDeclarations = parentDeclarations
                        if ('value' in rule && rule.value) {
                            if ('rules' in rule.value) {
                                parentRules = rule.value.rules as Rule[]
                            }
                            if ('declarations' in rule.value) {
                                parentDeclarations = rule.value.declarations
                            }
                        }
                        const name = rule.type === "custom-media"
                            ? rule.value.name
                            : rule.type === "keyframes"
                                ? rule.value.name.value
                                : null
                        if (name) {
                            let existing = UserProps[name]
                            if (!existing) {
                                existing = { dependencies: [], deletion: [] }
                                UserProps[name] = existing
                            }
                            const rulesToDeleteFrom = rule.parentRules
                            existing.deletion.push(() => rulesToDeleteFrom.splice(rulesToDeleteFrom.indexOf(rule), 1))
                        }
                    },
                    RuleExit(_rule) {
                        const rule = _rule as { parentRules?: Rule[], parentDeclarations?: DeclarationBlock }
                        if (rule.parentRules) {
                            parentRules = rule.parentRules
                        }
                        if (rule.parentDeclarations) {
                            parentDeclarations = rule.parentDeclarations
                        }
                    },
                    Declaration(d) {
                        if (d.property === "custom") {
                            const prop = d.value as typeof d.value & { parentProp?: CustomProperty }
                            prop.parentProp = parentProp
                            parentProp = prop
                            let existing = UserProps[prop.name]
                            if (!existing) {
                                existing = {
                                    dependencies: [],
                                    deletion: []
                                }
                                UserProps[prop.name] = existing
                            }
                            if (prop.parentProp) {
                                let match = UserProps[prop.parentProp.name]
                                if (!match) {
                                    match = {
                                        dependencies: [],
                                        deletion: []
                                    }
                                    UserProps[prop.parentProp.name] = match
                                }
                                match.dependencies.push(prop.name)
                            }
                            const declarationBlockToDeleteFrom = parentDeclarations
                            if (declarationBlockToDeleteFrom) {
                                existing.deletion.push(() => {
                                    const regularIndex = declarationBlockToDeleteFrom.declarations?.indexOf(d) || -1
                                    if (regularIndex > -1) {
                                        declarationBlockToDeleteFrom.declarations?.splice(regularIndex, 1)
                                    }
                                    const importantIndex = declarationBlockToDeleteFrom.importantDeclarations?.indexOf(d) || -1
                                    if (importantIndex > -1) {
                                        declarationBlockToDeleteFrom.importantDeclarations?.splice(importantIndex, 1)
                                    }
                                })
                            }
                        }
                    },
                    DeclarationExit: {
                        custom(p) {
                            const prop = p as { parentProp?: CustomProperty }
                            if (prop.parentProp) {
                                parentProp = prop.parentProp
                            }
                        }
                    },
                    StyleSheetExit(s) {
                        sourceStylesheet = s
                    },
                }
            })
        })
    }

    const foundProps = new Set<string>()
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
            if(!sourceStylesheet) return

            const rootRules = stylesheet.rules.map(r => r.type === "ignored" ? r : ({
                type: r.type,
                value: r.value
            } as ReturnedRule))

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

            for (const [key, value] of Object.entries(UserProps)) {
                if (value?.deletion && !STATE.mapped.has(key)) {
                    for (const d of value.deletion) {
                        d()
                    }
                }
            }

            rulesToAppend.unshift(...sourceStylesheet.rules)

            return {
                ...stylesheet,
                rules
            }
        },
        MediaQuery(query) {
            // bail early if possible
            if (processed.has(query)) return;
            for (const prop of getVars(query.condition)) {
                // lookup prop value from pool
                const value = UserProps[prop] || null

                // warn if media prop not resolved
                if (!value) {
                    return
                }

                // track work to prevent duplication
                STATE.mapped.add(prop)
            }
            processed.add(query)
        },

        Variable(variable) {
            if (processed.has(variable)) return;
            const { name: { ident: prop } } = variable
            // track work to prevent duplicative processing
            processed.add(variable)
            if (STATE.mapped.has(prop)) return;
            STATE.mapped.add(prop)
        },
    }
}
