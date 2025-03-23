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

    MediaCondition,
    StyleSheet,
    ReturnedRule,
    Rule,
    DeclarationBlock,
    PageMarginRule,
    Declaration,
} from 'lightningcss'

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

// const getAdaptivePropSelector = (selector: string | undefined): (s: string) => string =>
//     selector
//         ? prop => `${prop}${selector}`
//         : prop => `${prop}-@media:dark`


// function* getVariables(tokenOrValueArray: TokenOrValue[]): Generator<Variable> {
//     for (const tokenOrValue of tokenOrValueArray) {
//         switch (tokenOrValue.type) {
//             case "function":
//                 yield* getVariables(tokenOrValue.value.arguments)
//                 break;
//             case "var":
//                 yield tokenOrValue.value
//                 break;
//             // case 'unresolved-color':
//             //     yield* getVariables(tokenOrValue.value.alpha);
//             //     yield* getVariables(tokenOrValue.value.dark);
//             //     yield* getVariables(tokenOrValue.value.light);
//             //     break;
//             default:
//                 break;
//         }
//     }
// }

// function* getVariableDeclarationRecursive(props: Props, variable: Variable): Generator<ReturnedDeclaration> {
//     const declaration = props[variable.name.ident]
//     if (!isDeclaration(declaration?.value)) return;
//     yield declaration.value
//     if (declaration.value.property === "custom" && 'value' in declaration.value) {
//         const value = declaration.value.value
//         for (const variable of getVariables(value.value)) {
//             yield* getVariableDeclarationRecursive(props, variable)
//         }
//     }
// }

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

// const getMediaRuleKey = (r: MediaRule) => r.query.mediaQueries
//     .map(x => [...getMediaQueryKey(x)].join("|"))
//     .sort()
//     .join('|||')

// function* getMediaQueryKey(q: ReturnedMediaQuery): Generator<string> {
//     if ('raw' in q) {
//         yield q.raw
//         return
//     }
//     yield* getFeatures(q.condition)
//     if (q.qualifier) yield q.qualifier
//     if (q.mediaType) yield q.mediaType
// }

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


function* purgeRules<R extends Rule[] | PageMarginRule[]>(rules: R, vars: Set<string>): Generator<R extends Rule[] ? Rule : PageMarginRule> {
    for (const rule of rules) {
        if (!("type" in rule) || rule.type === "font-feature-values") {
            // page margin rule
            yield rule as R extends Rule[] ? Rule : PageMarginRule;
            continue;
        }
        if (rule.type === "keyframes" && !vars.has(rule.value.name.value)) continue;
        if (rule.type === "custom-media" && !vars.has(rule.value.name)) continue;
        if (!("value" in rule && rule.value && (("rules" in rule.value) || "declarations" in rule.value))) {
            yield rule as R extends Rule[] ? Rule : PageMarginRule;
            continue
        }
        const mappedRule = {
            ...rule,
            value: {
                ...rule.value
            }
        }
        if ("rules" in mappedRule.value && mappedRule.value.rules) {
            mappedRule.value.rules = [...purgeRules(mappedRule.value.rules, vars)] as Rule[] | PageMarginRule[]
        }
        if ("declarations" in mappedRule.value && mappedRule.value.declarations) {
            if (mappedRule.value.declarations.declarations) {
                mappedRule.value.declarations.declarations = [...purgeDeclarations(mappedRule.value.declarations.declarations, vars)]
            }
            if (mappedRule.value.declarations.importantDeclarations) {
                mappedRule.value.declarations.importantDeclarations = [...purgeDeclarations(mappedRule.value.declarations.importantDeclarations, vars)]
            }
        }
        yield mappedRule as R extends Rule[] ? Rule : PageMarginRule
    }
}

function* purgeDeclarations(declarations: Declaration[], vars: Set<string>) {
    for (const declaration of declarations) {
        if (declaration.property === "custom" && !vars.has(declaration.value.name)) continue;
        yield declaration
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
                visitor: {
                    StyleSheet(s) {
                        sourceStylesheet = s
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
                                existing = { dependencies: [], deletion: [] }
                                UserProps[name] = existing
                            }
                            const rulesToDeleteFrom = parent.rules
                            if (rulesToDeleteFrom) {
                                existing.deletion.push(() => {
                                    const index = rulesToDeleteFrom.indexOf(rule)
                                    if (index > -1) {
                                        rulesToDeleteFrom.splice(index, 1)
                                    }
                                })
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
                                    deletion: []
                                }
                                UserProps[prop.name] = existing
                            }
                            parentProp = existing
                            const declarationBlockToDeleteFrom = parent.declarations
                            if (declarationBlockToDeleteFrom) {
                                existing.deletion.push(() => {
                                    const regularIndex = declarationBlockToDeleteFrom.declarations?.findIndex(x => x.property === "custom" && x.value.name === prop.name) ?? -1
                                    if (regularIndex > -1) {
                                        declarationBlockToDeleteFrom.declarations?.splice(regularIndex, 1)
                                    }
                                    const importantIndex = declarationBlockToDeleteFrom.importantDeclarations?.findIndex(x => x.property === "custom" && x.value.name === prop.name) ?? -1
                                    if (importantIndex > -1) {
                                        declarationBlockToDeleteFrom.importantDeclarations?.splice(importantIndex, 1)
                                    }
                                })
                            }
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
            if (!sourceStylesheet) return

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

            rulesToAppend.push(...purgeRules(sourceStylesheet.rules, STATE.mapped as Set<string>))

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
