'use strict'

const { globalIgnores } = require('eslint/config')
const neostandard = require('neostandard')

module.exports = [
  globalIgnores(['build/', '.claude/']),
  ...neostandard({ env: ['node'], noJsx: true }),
  {
    rules: {
      'dot-notation': 'error',
      '@stylistic/comma-dangle': ['error', 'never'],
      'n/no-deprecated-api': 'error'
    }
  }
]
