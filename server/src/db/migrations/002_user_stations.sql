ALTER TABLE organization_members
ADD COLUMN default_station_id UUID REFERENCES stations(id) ON DELETE SET NULL;
