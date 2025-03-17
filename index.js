// adapted from https://github.com/GoogleChromeLabs/postcss-jit-props/blob/main/index.js
import { readFileSync } from 'node:fs'
import crypto from "node:crypto"
import glob from "tiny-glob/sync.js"
import { Buffer } from "node:buffer"

/**
 * @typedef {import("lightningcss").CustomAtRules} CustomAtRules
 * @typedef {import("lightningcss").MediaCondition} MediaCondition
 * @typedef {import("lightningcss").Visitor<CustomAtRules>} Visitor
 * @typedef {import("lightningcss").Selector} Selector
 * @typedef {import("lightningcss").ReturnedDeclaration} ReturnedDeclaration
 * @typedef {import("lightningcss").ReturnedRule} ReturnedRule
 * @typedef {import("lightningcss").ReturnedMediaQuery} ReturnedMediaQuery
 * @typedef {import("lightningcss").Location2} Location2
 * @typedef {import("lightningcss").MediaFeatureId} MediaFeatureId
 * @typedef {import("lightningcss").CustomMediaRule} CustomMediaRule
 * @typedef {import("lightningcss").KeyframesRule} KeyframesRule
 * 
 * @typedef {CustomMediaRule | ReturnedDeclaration | KeyframesRule<ReturnedDeclaration> | null | undefined} PropValue
 * 
 * @typedef {Record<string, PropValue>} Props
 * 
 * @typedef {import('.').Options} Options
 * 
 * @typedef {{
 *   mapped: Set<string | number>,         
 *   mapped_dark: Set<string | number>,
 *   target_rule: ReturnedDeclaration[],
 *   target_rule_dark: ReturnedDeclaration[],
 *   target_media_dark: KeyframesRule<ReturnedDeclaration>[],
 *   keyframes: KeyframesRule<ReturnedDeclaration>[],
 *   custom_media: CustomMediaRule<ReturnedMediaQuery>[]
 * }} State
 */

import {
    bundle,
    transform
} from 'lightningcss';

const loc = {
    column: 0,
    line: 0,
    source_index: 0
}

const processed = new WeakSet();

/**
 * @param {string | undefined} selector 
 * @returns {(s: string) => string}
 */
const getAdaptivePropSelector = (selector) =>
    selector
        ? prop => `${prop}${selector}`
        : prop => `${prop}-@media:dark`

/**
 * @param {import('.').PropValue} value 
 * @returns {value is KeyframesRule<ReturnedDeclaration>}
 */
function isKeyFrames(value) {
    return !!value && 'keyframes' in value
}

/**
 * @param {import('.').PropValue} value 
 * @returns {value is ReturnedDeclaration}
 */
function isDeclaration(value) {
    return !!value && 'property' in value
}

/**
 * @param {import('.').PropValue} value 
 * @returns {value is CustomMediaRule}
 */
function isCustomMedia(value) {
    return !!value && 'query' in value
}

/**
 * @returns {State}
 */
const getState = () => (
    {
        mapped: new Set(),            // track prepended props
        mapped_dark: new Set(),       // track dark mode prepended props
        target_rule: [],       // :root for props
        target_rule_dark: [],  // :root for dark props
        target_media_dark: [], // dark media query props
        keyframes: [],
        custom_media: []
    }
)

/**
 * @param {MediaCondition | null | undefined} condition 
 * @returns {string[]}
 */
const getVars = (condition) => {
    if (condition?.type === "not") return getVars(condition.value)
    if (condition?.type === "operation") return condition.conditions.map(getVars).flat()
    if (condition?.value.name.startsWith('--')) return [condition.value.name]
    return []
}

/**
 * @param {string} k 
 * @returns {k is `--${string}`}
 */
const isValidKey = (k) => k.startsWith('--')

/**
 * @param {Record<string, string | number>} p 
 */
function* parseProps(p) {
    for (const [property, value] of Object.entries(p)) {
        if (!isValidKey(property)) continue;

        if (typeof value === "string") {
            if (value.startsWith('@keyframes')) {
                /** @type {KeyframesRule<ReturnedDeclaration> | undefined} */
                let rule
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
                /** @type {CustomMediaRule<ReturnedMediaQuery> | undefined} */
                let rule
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
            property,
            raw: value.toString()
        }]
    }
}

/**
 * @param {Options} options 
 * @returns {Visitor}
 */
export default function plugin(options) {
    const {
        files,
        adaptive_prop_selector,
        custom_selector,
        custom_selector_dark,
        layer,
        ...props
    } = options

    const FilePropsCache = new Map();

    /** @type {Props} */
    const UserProps = Object.fromEntries(parseProps(props))

    const STATE = getState()

    const adaptivePropSelector = getAdaptivePropSelector(adaptive_prop_selector)

    if (!files?.length && !Object.keys(props).length) {
        console.warn('lightningcss-jit-props: Variable source(s) not passed.')
        return {}
    }

    if (files?.length) {

        const globs = files
            .map((file) => glob(file))
            .flat()

        globs.forEach(file => {
            let data = readFileSync(file)

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

            bundle({
                filename: file,
                drafts: {
                    customMedia: true
                },
                visitor: {
                    Declaration: {
                        custom(p) {
                            UserProps[p.name] = {
                                property: "custom",
                                value: p
                            }
                        }
                    },
                    Rule: {
                        'custom-media'({ value }) {
                            UserProps[value.name] = value
                            fileProps.set(value.name, value)
                        },
                        'keyframes'({ value }) {
                            const keyframeName = `--${value.name.value}-@`
                            UserProps[keyframeName] = value
                            fileProps.set(keyframeName, value)
                        }
                    }
                }
            })
        })
    }

    return {
        StyleSheet() {
            Object.assign(STATE, getState())
        },

        StyleSheetExit(stylesheet) {
            /** @type {Selector} */
            const rootSelector = [{ kind: "root", type: "pseudo-class" }]
            const target_selector = custom_selector || rootSelector
            const target_selector_dark = custom_selector_dark || target_selector

            const rootRules = stylesheet.rules.map(r => ({
                type: r.type,
                value: r.value
            }))

            /** @type {ReturnedRule[] | undefined} */
            let rulesToAppend,
                /** @type {ReturnedRule[] | undefined} */
                rules

            if (layer) {
                rulesToAppend = []
                /** @type {ReturnedRule} */
                const layerRule = {
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

            rulesToAppend.unshift(...STATE.custom_media.map(m => ({
                type: "custom-media",
                value: m
            })), {
                type: 'style',
                value: {
                    selectors: [
                        target_selector
                    ],
                    declarations: {
                        declarations: STATE.target_rule
                    },
                    loc
                }
            })

            rulesToAppend.push(...STATE.keyframes.map(k => ({
                type: "keyframes",
                value: k
            })))

            if (STATE.target_rule_dark.length || STATE.target_media_dark.length) {
                /** @type {ReturnedRule[]} */
                const darkRules = []

                if (STATE.target_rule_dark.length) {
                    darkRules.push({
                        type: 'style',
                        value: {
                            selectors: [
                                target_selector_dark
                            ],
                            declarations: {
                                declarations: STATE.target_rule_dark
                            },
                            loc
                        }
                    })
                }

                darkRules.push(...STATE.target_media_dark.map(k => ({
                    type: "keyframes",
                    value: k
                })))

                rulesToAppend.push({
                    type: 'media',
                    value: {
                        loc,
                        query: {
                            mediaQueries: [
                                {
                                    mediaType: "all",
                                    condition: {
                                        type: "feature",
                                        value: {
                                            name: "prefers-color-scheme",
                                            type: "plain",
                                            value: {
                                                type: "ident",
                                                value: "dark"
                                            }
                                        }
                                    }
                                }
                            ]
                        },
                        rules: darkRules,
                    }
                })
            }

            return {
                ...stylesheet,
                rules
            }
        },
        MediaQuery(query) {
            // bail early if possible
            if (processed.has(query)) return;
            const vars = getVars(query.condition)
            vars.forEach(prop => {

                // lookup prop value from pool
                let value = UserProps[prop] || null

                // warn if media prop not resolved
                if (!isCustomMedia(value)) {
                    return
                }

                // prepend the custom media
                STATE.custom_media.push(value)

                // track work to prevent duplication
                STATE.mapped.add(prop)
            })
            processed.add(query)
        },

        Variable(variable) {
            if (processed.has(variable)) return;
            const { name: { ident: prop } } = variable
            const value = UserProps[prop]

            // warn if props won't resolve from plugin
            if (!isDeclaration(value)) {
                return
            }

            // create and append prop to :root
            STATE.target_rule.push(value)
            STATE.mapped.add(prop)

            // lookup keyframes for the prop and append if found
            let keyframes = UserProps[`${prop}-@`]
            if (isKeyFrames(keyframes)) {
                STATE.keyframes.push(keyframes)
            }

            // lookup dark adaptive prop and append if found
            const adaptive = UserProps[adaptivePropSelector(prop)]
            if (adaptive && !STATE.mapped_dark.has(prop)) {
                if (isKeyFrames(adaptive)) {
                    STATE.target_media_dark.push(adaptive)
                }
                else if (isDeclaration(adaptive) && isValidKey(prop)) {
                    // append adaptive prop definition to dark media query
                    STATE.target_rule_dark.push({
                        ...adaptive,
                        property: prop
                    })
                    STATE.mapped_dark.add(prop)
                }
            }

            // track work to prevent duplicative processing
            processed.add(variable)
        },
    }
}
