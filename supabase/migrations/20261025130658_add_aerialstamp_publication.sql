-- Source: https://eartharxiv.org/repository/view/15721/ (published 2026-10-23).
-- The About page reads this table and orders papers by publication_date.
INSERT INTO public.publications (title, authors, year, publication_date, publisher, url)
SELECT
    'AerialStamp: dating aerial orthophotos from visual cues and Sentinel-2 time series',
    'Clemens Mosig, David Montero Loaiza, Miguel Mahecha, Janusch Vajna-Jehle, Teja Kattenborn',
    '2026',
    DATE '2026-10-23',
    'EarthArXiv preprint',
    'https://doi.org/10.31223/X5SZ4Q'
WHERE NOT EXISTS (
    SELECT 1
    FROM public.publications
    WHERE url IN (
        'https://doi.org/10.31223/X5SZ4Q',
        'https://eartharxiv.org/repository/view/15721/',
        'https://eartharxiv.org/repository/view/15721'
    )
    OR title = 'AerialStamp: dating aerial orthophotos from visual cues and Sentinel-2 time series'
);
