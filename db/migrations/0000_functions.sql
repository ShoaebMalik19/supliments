CREATE OR REPLACE FUNCTION uuid_generate_v7() RETURNS uuid
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  ms bigint := floor(extract(epoch FROM clock_timestamp()) * 1000);
  bytes bytea := uuid_send(gen_random_uuid());
BEGIN
  bytes := set_byte(bytes, 0, ((ms >> 40) & 255)::int);
  bytes := set_byte(bytes, 1, ((ms >> 32) & 255)::int);
  bytes := set_byte(bytes, 2, ((ms >> 24) & 255)::int);
  bytes := set_byte(bytes, 3, ((ms >> 16) & 255)::int);
  bytes := set_byte(bytes, 4, ((ms >> 8) & 255)::int);
  bytes := set_byte(bytes, 5, (ms & 255)::int);
  bytes := set_byte(bytes, 6, (get_byte(bytes, 6) & 15) | 112);
  bytes := set_byte(bytes, 8, (get_byte(bytes, 8) & 63) | 128);
  RETURN encode(bytes, 'hex')::uuid;
END $$;
