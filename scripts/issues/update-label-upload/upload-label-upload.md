i need to decide now if i have a label upload or not.

finally i want to have all labels craeted from the processor, the processor does not need to talk with the database via the api. He can create the labels and save them to the database. this could be done by adding the geometries which are larges in chunks.

i would need to create some kind of helper function or something to do this.

now since i am in a hurry because of the next conference, i could try to use the labes craeted by clemens and upload them directly rather the let the prcessor crate them.

But do upload the labesl i dont need the api, but rather the helper function. I could seperate them a bit, so that i can use them in the processor or elsewere, for example on clemens servers where all the data is stored.

this way i can reuse the code for the upload and the processor.

so no label upload, via the api any more.

to import data in an outomated wayy i would need to have a cli which can upload orthos via the api craeting the dataset and also start all the processeing. This cli could also have a function to upload the labels.

But how can i use them in the processor whilc have them completly seperated?

## folder on the server

- deadwood_segmentation_predictions_full_120 (1784) is complete? (all deadwood labels)
- labels_and_aoi (only the handmade labels?) (1179) (area only aois)
- tree_cover_vectors (1784)
- orthopohots_predicted_forest_convert (1789)
- unlabeled_orthos (?)

what comes clear is not, i need a way to directly upload the labels to the database.

No small scatch of an importer module:

- importer uses the api to upload datasets and starts the relevant processes
- uses the create_label_with_geometries function to upload the labels

it should work as a cli or as a module without docker dependencies.

waht i need to do is:

- move the create_label_with_geometries to the shared folder
- build the module
- run the module agains the entire system.
