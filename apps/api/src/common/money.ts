import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@touma/database';

export type Money = string | null | undefined;

export const toDecimal = (v: Money) => (v === undefined ? undefined : v === null ? null : new Prisma.Decimal(v));
export const moneyOut = (v: Prisma.Decimal | null) => (v === null ? null : v.toFixed(2));

/** Exact decimal comparison: the discount must be strictly lower than the price and needs a price. */
export function assertDiscount(price: Prisma.Decimal | null, discount: Prisma.Decimal | null) {
  if (discount === null) return;
  if (price === null) {
    throw new BadRequestException({ code: 'VALIDATION', message: ['discountPrice requires a price'] });
  }
  if (!discount.lessThan(price)) {
    throw new BadRequestException({ code: 'VALIDATION', message: ['discountPrice must be lower than price'] });
  }
}
