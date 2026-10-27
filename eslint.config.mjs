import eslint from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
	{
		files: ['src/**/*.ts'],
		extends: [
			eslint.configs.recommended,
			tseslint.configs.recommended,
		],
		rules: {
			'@typescript-eslint/no-unused-vars': ['warn', { 'argsIgnorePattern': '^_', 'varsIgnorePattern': '^_' }],
			'@typescript-eslint/no-explicit-any': 'warn',
			'no-console': 'warn',
			'semi': ['error', 'always'],
			'quotes': ['error', 'single', { 'avoidEscape': true }]
		},
	},
	{
		ignores: ['out/', 'dist/', 'scripts/', '**/*.d.ts'],
	}
);
