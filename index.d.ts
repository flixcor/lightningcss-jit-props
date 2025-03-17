import type {
    CustomAtRules,
    Visitor
} from 'lightningcss';

export type Options = {
    files?: string[],
    custom_selector?: Selector,
    custom_selector_dark?: Selector,
    adaptive_prop_selector?: string,
    layer?: string,
} & {
    [k: `--${string}`]: string | number
}

export default function plugin(options: Options): Visitor<CustomAtRules>