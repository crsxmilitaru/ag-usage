import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
	eslint.configs.recommended,
	...tseslint.configs.recommended,
	{
		files: ['src/**/*.ts'],
		languageOptions: {
			parserOptions: {
				project: './tsconfig.json',
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			'@typescript-eslint/no-unused-vars': ['warn', { 'argsIgnorePattern': '^_', 'varsIgnorePattern': '^_' }],
			'@typescript-eslint/no-explicit-any': 'warn',
			'no-console': 'warn',
			'semi': ['error', 'always'],
			'quotes': ['error', 'single', { 'avoidEscape': true }]
		},
	},
	{
		ignores: ['out/', 'dist/', '**/*.d.ts'],
	}
);
