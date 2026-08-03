-- Milestone 2 (spec §6, build order item 2): "Two rules inserted by hand as
-- SQL. Verify expandRule materialises correct mappings."
--
-- The two torrents/file lists below are the first two real examples from
-- spec §1, transcribed as-is. Both use numbering:'sequential' because
-- that's what's actually true of these releases -- there is no SxxExx or
-- other explicit marker in either, just an implicit "01 выпуск.mp4, 02
-- выпуск.mp4, ..." run, which is exactly the case §3.6/§3.7's sequential
-- mode exists for. (continuous/manual/exceptions are exercised in
-- test/resolve/expandRule.test.ts instead, since those don't need real
-- torrent data to verify -- expandRule is pure.)
--
-- Idempotent: re-running this file first clears out anything it previously
-- inserted, identified by the two fixed torrent hashes below.

delete from torrents where hash in (
  'sokrovishcha-imperatora-s03-milestone2',
  'stavka-na-lyubov-s02-milestone2'
);
delete from titles where name_ru in ('Сокровища императора', 'Ставка на любовь');

-- Example 1 (§1): "Сокровища императора 3 сезон 8 из 13 выпуск (Ольга Бузова
-- и Михаил Галустян) [2026, путешествие, реалити-шоу, развлекательный, HDRip
-- 1080p]" -- files 01..08 выпуск.mp4, 5GB each. 8 of 13 season episodes
-- present (the "8 из 13" completeness count is a confidence-scoring input,
-- §3.4/§5.3 -- Milestone 5 -- and plays no part in expandRule itself).

insert into torrents (hash, torbox_id, raw_name_at_ingest, total_size, last_seen)
values (
  'sokrovishcha-imperatora-s03-milestone2',
  1001,
  'Сокровища императора 3 сезон 8 из 13 выпуск (Ольга Бузова и Михаил Галустян) [2026, путешествие, реалити-шоу, развлекательный, HDRip 1080p]',
  40000000000,
  now()
);

insert into files (torrent_hash, torbox_file_id, raw_path, size, is_video)
values
  ('sokrovishcha-imperatora-s03-milestone2', 1, '01 выпуск.mp4', 5000000000, true),
  ('sokrovishcha-imperatora-s03-milestone2', 2, '02 выпуск.mp4', 5000000000, true),
  ('sokrovishcha-imperatora-s03-milestone2', 3, '03 выпуск.mp4', 5000000000, true),
  ('sokrovishcha-imperatora-s03-milestone2', 4, '04 выпуск.mp4', 5000000000, true),
  ('sokrovishcha-imperatora-s03-milestone2', 5, '05 выпуск.mp4', 5000000000, true),
  ('sokrovishcha-imperatora-s03-milestone2', 6, '06 выпуск.mp4', 5000000000, true),
  ('sokrovishcha-imperatora-s03-milestone2', 7, '07 выпуск.mp4', 5000000000, true),
  ('sokrovishcha-imperatora-s03-milestone2', 8, '08 выпуск.mp4', 5000000000, true);

with t as (
  insert into titles (name_ru) values ('Сокровища императора') returning id
)
insert into rules (torrent_hash, title_id, season, numbering, sort, start_episode, confidence, source)
select 'sokrovishcha-imperatora-s03-milestone2', t.id, 3, 'sequential', 'natural', 1, 1.0, 'manual'
from t;

-- Example 2 (§1): "Ставка на любовь 2 сезон 10 из 10 выпуск (Регина
-- Тодоренко и Влад Топалов) [2026, реалити, WEBRip, 1080p]" -- files
-- 01..10 выпуск.mp4. Season complete (10 из 10).

insert into torrents (hash, torbox_id, raw_name_at_ingest, total_size, last_seen)
values (
  'stavka-na-lyubov-s02-milestone2',
  1002,
  'Ставка на любовь 2 сезон 10 из 10 выпуск (Регина Тодоренко и Влад Топалов) [2026, реалити, WEBRip, 1080p]',
  35000000000,
  now()
);

insert into files (torrent_hash, torbox_file_id, raw_path, size, is_video)
values
  ('stavka-na-lyubov-s02-milestone2', 1, '01 выпуск.mp4', 3500000000, true),
  ('stavka-na-lyubov-s02-milestone2', 2, '02 выпуск.mp4', 3500000000, true),
  ('stavka-na-lyubov-s02-milestone2', 3, '03 выпуск.mp4', 3500000000, true),
  ('stavka-na-lyubov-s02-milestone2', 4, '04 выпуск.mp4', 3500000000, true),
  ('stavka-na-lyubov-s02-milestone2', 5, '05 выпуск.mp4', 3500000000, true),
  ('stavka-na-lyubov-s02-milestone2', 6, '06 выпуск.mp4', 3500000000, true),
  ('stavka-na-lyubov-s02-milestone2', 7, '07 выпуск.mp4', 3500000000, true),
  ('stavka-na-lyubov-s02-milestone2', 8, '08 выпуск.mp4', 3500000000, true),
  ('stavka-na-lyubov-s02-milestone2', 9, '09 выпуск.mp4', 3500000000, true),
  ('stavka-na-lyubov-s02-milestone2', 10, '10 выпуск.mp4', 3500000000, true);

with t as (
  insert into titles (name_ru) values ('Ставка на любовь') returning id
)
insert into rules (torrent_hash, title_id, season, numbering, sort, start_episode, confidence, source)
select 'stavka-na-lyubov-s02-milestone2', t.id, 2, 'sequential', 'natural', 1, 1.0, 'manual'
from t;
