import { schema, table } from "@intentius/chant-lexicon-sql/postgres";

export const shop = schema`CREATE SCHEMA shop`;

export const customers = table`
  CREATE TABLE ${shop}.customers (
      id bigint GENERATED ALWAYS AS IDENTITY,
      email text NOT NULL,
      CONSTRAINT customers_pkey PRIMARY KEY (id)
  )`;

export const orders = table`
  CREATE TABLE ${shop}.orders (
      id bigint GENERATED ALWAYS AS IDENTITY,
      customer_id bigint NOT NULL REFERENCES ${customers} (id),
      CONSTRAINT orders_pkey PRIMARY KEY (id)
  )`;
