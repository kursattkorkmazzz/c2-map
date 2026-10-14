// Testing Library otomatik temizliği `globals: true` ister; burada açıkça: her testten sonra
// render edilenler kaldırılır (önceki testin DOM'u sonrakini etkilemesin).
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => cleanup());
