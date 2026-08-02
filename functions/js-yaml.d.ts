declare module 'js-yaml' {
  export const JSON_SCHEMA: object

  export function load(
    value: string,
    options?: {
      json?: boolean
      schema?: object
    },
  ): unknown
}
